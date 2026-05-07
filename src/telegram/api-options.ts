import type { TelegramSendOptions } from "../types";

export function toTelegramMethodOptions(options: TelegramSendOptions): { business_connection_id?: string } {
  return options.businessConnectionId ? { business_connection_id: options.businessConnectionId } : {};
}
