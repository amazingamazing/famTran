import type { ServerEvent } from "@family-translation/shared";

export const parseEvent = (rawData: string): ServerEvent | null => {
  try {
    return JSON.parse(rawData) as ServerEvent;
  } catch {
    return null;
  }
};

