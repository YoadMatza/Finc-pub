import { input } from '@inquirer/prompts';

/** Where an OTP code comes from when a bank asks for one. Console now, Telegram later (§7d). */
export type OtpProvider = (ctx: { institutionId: string }) => Promise<string>;

export const consoleOtp: OtpProvider = async ({ institutionId }) => {
  if (!process.stdin.isTTY) throw new Error(`${institutionId} asked for an OTP but there is no terminal to type it in`);
  const code = await input({ message: `${institutionId}: enter the one-time code the bank sent you` });
  return code.trim();
};

export const noOtp: OtpProvider = async ({ institutionId }) => {
  throw new Error(`${institutionId} requires an OTP and no OTP provider is configured`);
};
