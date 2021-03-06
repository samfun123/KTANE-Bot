import { exec, ExecException } from "child_process";
import { AkairoClient } from "discord-akairo";
import { Message, MessageEmbed } from "discord.js";
import { createWriteStream, unlink } from "fs";
import got from "got";
import path from "path";
import stream from "stream";
import { promisify } from "util";
import { joinLimit, update } from "./bot-utils";
import tokens from "./get-tokens";
import Logger from "./log";
import TaskManager from "./task-manager";

const pipeline = promisify(stream.pipeline);

function pluralize(count: number, noun: string) {
	return `${count} ${noun}${count !== 1 ? "s" : ""}`;
}

// https://stackoverflow.com/a/54024653
// input: h in [0,360] and s,v in [0,1] - output: r,g,b in [0,255]
function hsv2rgb(h: number, s: number, v: number): [number, number, number] {
	const f = (n: number, k = (n + h / 60) % 6) => v - v * s * Math.max(Math.min(k, 4 - k, 1), 0);
	return [f(5) * 255, f(3) * 255, f(1) * 255];
}

export default async function lintMessage(message: Message, client: AkairoClient): Promise<void> {
	const extensions = [".zip", ".rar", ".7z", ".html", ".svg", ".json"];
	const file = Array.from(message.attachments.values()).find(attachment => extensions.some(extension => attachment.name?.endsWith(extension)));
	if (file === undefined || file.name === null)
		return;

	const fileName = message.id + file.name.substring(file.name.lastIndexOf("."));
	const notInDM = message.channel.type !== "dm";
	if (notInDM) await message.react("💭");

	try {
		await pipeline(
			got.stream(file.url),
			createWriteStream(fileName)
		);

		const report = await lintZip(message, fileName, file.name);
		if (report === null)
			await message.react("👍");
		else
			await update<Record<string, string>>(client.settings, message.guild !== null ? message.guild.id : message.channel.id, "reportMessages", {}, (value) => {
				value[message.id] = report.id;
				return value;
			});
	} catch (error) {
		Logger.error("Linting failed.", error);
		TaskManager.sendOwnerMessage("An error ocurred while linting. Check the logs.");

		await message.react("⚠️");
	} finally {
		unlink(fileName, error => {
			if (error != null) {
				Logger.error("Unlinking failed:", error);
			}
		});

		if (notInDM) await message.reactions.cache.get("💭")?.remove();
	}
}

function lintZip(message: Message, zipPath: string, originalName: string): Promise<Message | null> {
	return new Promise((resolve, reject) => {
		exec(`dotnet run -c Release --no-build ${path.resolve(zipPath)}`, { cwd: tokens.repoLintPath }, (error: ExecException | null, stdout: string, stderr: string) => {
			if (error !== null || stderr !== "") {
				// RepoLint will use error code 2 to represent an error with the user input.
				if (error !== null && error.code == 2 && stderr !== "") {
					resolve(message.reply(stderr));
					return;
				}

				reject(error ?? stderr);
				return;
			}

			const files = [];
			let file: { name: string, problems: string[] } | null = null;
			let totalProblems = 0;
			for (let line of stdout.split("\n")) {
				line = line.trimEnd();
				if (line === "")
					continue;

				if (!line.startsWith("    ")) {
					file = { name: line, problems: [] };
					files.push(file);

					const match = /\((\d+) problems?\)$/.exec(line);
					if (match == null) {
						Logger.error("Unable to match problem count:", line);
						continue;
					}

					totalProblems += parseInt(match[1]);
				} else if (file !== null) {
					file.problems.push(line);
				}
			}

			if (totalProblems === 0) {
				resolve(null);
				return;
			}

			const embed = new MessageEmbed()
				.setTitle("Linting Completed")
				.setURL(message.url)
				.setDescription(`Found ${pluralize(totalProblems, "problem")} in ${pluralize(files.length, "file")}.`)
				.setFooter(originalName)
				.setColor(hsv2rgb((1 - Math.min(totalProblems, 15) / 15) * 120, 1, 1));

			for (let i = 0; i < Math.min(files.length, 25); i++) {
				const file = files[i];
				const field = { name: file.name, value: joinLimit(file.problems, "\n", 1024) };

				if (embed.length + field.name.length + field.value.length > 6000)
					break;

				embed.addField(field.name, field.value);
			}

			const report = message.channel.send(embed);
			resolve(report);
		});
	});
}
