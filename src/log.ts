/* eslint-disable no-console */
import { Message } from "discord.js";
import { inspect } from "util";

const levels: { [level: string]: (...data: unknown[]) => void } = {
	info: console.log,
	error: console.error,
	warn: console.warn,
};

export default class Logger {
	static log(level = "log", ...data: unknown[]): void {
		const logMessage = `[${new Date().toISOString()}] [${level}] ${data.map(data => typeof data == "string" ? data : inspect(data)).join(" ")}`;

		levels[level](logMessage);
	}
	static info(...data: unknown[]): void { Logger.log("info", ...data); }
	static error(...data: unknown[]): void { Logger.log("error", ...data); }
	static warn(...data: unknown[]): void { Logger.log("warn", ...data); }
	static errorReply(reason: string, message: Message) {
		return (...data: unknown[]): Promise<Message> => {
			Logger.error(...data);
			return message.reply(`Failed to ${reason}.`);
		};
	}
}