import type { Context } from "grammy";
import type { AppConfig } from "../types";

export function isSupportedChat(ctx: Context, appConfig: AppConfig): boolean {
  return isTeamGroupChat(ctx, appConfig) || ctx.chat?.type === "private";
}

export function isAllowedGroupChat(ctx: Context, appConfig: AppConfig): boolean {
  return appConfig.allowedGroupId !== null && ctx.chat?.id === appConfig.allowedGroupId;
}

export function isTeamGroupChat(ctx: Context, appConfig: AppConfig): boolean {
  if (ctx.chat?.type !== "group" && ctx.chat?.type !== "supergroup") return false;
  return appConfig.allowedGroupId === null || ctx.chat.id === appConfig.allowedGroupId;
}

export async function canUsePrivateDm(ctx: Context, appConfig: AppConfig): Promise<boolean> {
  const userId = ctx.from?.id;

  if (!userId) return false;

  return canUseTelegramUser(userId, ctx.api, appConfig);
}

export async function canUseTelegramUser(
  userId: number,
  api: Context["api"],
  appConfig: AppConfig,
): Promise<boolean> {
  if (appConfig.allowedUserIds.size === 0 && appConfig.allowedGroupId === null) {
    return true;
  }

  if (appConfig.allowedUserIds.has(userId)) {
    return true;
  }

  if (appConfig.allowedGroupId !== null) {
    try {
      const member = await api.getChatMember(appConfig.allowedGroupId, userId);
      return isActiveMemberStatus(member.status);
    } catch (error) {
      console.error(
        `Failed to verify whether user ${userId} belongs to group ${appConfig.allowedGroupId}:`,
        error,
      );
    }
  }

  return false;
}

export function getUnauthorizedMessage(appConfig: AppConfig): string {
  return appConfig.allowedGroupId !== null
    ? "Sorry, you are not allowed to use this bot. You must be explicitly whitelisted or belong to the configured Telegram group."
    : "Sorry, you are not allowed to use this bot. You must be explicitly whitelisted.";
}

export async function replyUnauthorized(ctx: Context, appConfig: AppConfig): Promise<void> {
  await ctx.reply(getUnauthorizedMessage(appConfig));
}

function isActiveMemberStatus(status: string): boolean {
  return (
    status === "creator" ||
    status === "administrator" ||
    status === "member" ||
    status === "restricted"
  );
}
