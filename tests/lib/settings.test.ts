// src/lib/settings.ts — 킬 스위치 (05-api §6)

import { describe, expect, it } from "vitest";
import { query } from "@/lib/db";
import {
  publicReadEnabled,
  retentionHealthy,
  writingEnabled,
} from "@/lib/settings";

async function setFlag(key: string, value: boolean): Promise<void> {
  await query("update app_settings set value = $2::jsonb where key = $1", [
    key,
    JSON.stringify(value),
  ]);
}

describe("app_settings 기본값 (0002_settings_seed.sql · 0006_retention_switch.sql)", () => {
  it("세 스위치가 켜진 채로 시작한다", async () => {
    const { rows } = await query<{ key: string; value: unknown }>(
      "select key, value from app_settings order by key",
    );
    // 앞의 둘은 운영자가 끄고, `retention_healthy`는 **파기 잡이** 끈다 (D-031).
    expect(rows).toEqual([
      { key: "public_read_enabled", value: true },
      { key: "retention_healthy", value: true },
      { key: "writing_enabled", value: true },
    ]);
    expect(await publicReadEnabled()).toBe(true);
    expect(await writingEnabled()).toBe(true);
    expect(await retentionHealthy()).toBe(true);
  });
});

describe("킬 스위치", () => {
  it("끄면 즉시 반영된다 — 프로세스 캐시가 없다", async () => {
    // 같은 프로세스에서 이미 한 번 읽은 값이라도 다음 호출은 DB를 다시 본다.
    expect(await writingEnabled()).toBe(true);
    await setFlag("writing_enabled", false);
    expect(await writingEnabled()).toBe(false);
    await setFlag("writing_enabled", true);
    expect(await writingEnabled()).toBe(true);
  });

  it("두 스위치는 서로 독립이다", async () => {
    await setFlag("public_read_enabled", false);
    expect(await publicReadEnabled()).toBe(false);
    expect(await writingEnabled()).toBe(true);
    await setFlag("public_read_enabled", true);
  });

  it("행이 없으면 켜진 것으로 본다", async () => {
    await query("delete from app_settings where key = 'writing_enabled'");
    expect(await writingEnabled()).toBe(true);
    await query(
      "insert into app_settings (key, value) values ('writing_enabled', 'true'::jsonb)",
    );
  });
});
