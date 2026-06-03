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

  if (appConfig.allowedUserIds.size === 0 && appConfig.allowedGroupId === null) {
    return true;
  }

  if (appConfig.allowedUserIds.has(userId)) {
    return true;
  }

  if (appConfig.allowedGroupId !== null) {
    try {
      const member = await ctx.api.getChatMember(appConfig.allowedGroupId, userId);
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

export async function replyUnauthorized(ctx: Context, appConfig: AppConfig): Promise<void> {
  const message = appConfig.allowedGroupId !== null
    ? "Sorry, you are not allowed to use this bot. You must be explicitly whitelisted or belong to the configured Telegram group."
    : "Sorry, you are not allowed to use this bot. You must be explicitly whitelisted.";

  await ctx.reply(message);
}

function isActiveMemberStatus(status: string): boolean {
  return (
    status === "creator" ||
    status === "administrator" ||
    status === "member" ||
    status === "restricted"
  );
}
