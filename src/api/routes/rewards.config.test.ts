import { expect, test } from "bun:test";
import { rewards } from "./rewards.js";
import { ACTIONS, BADGES, LEVELS } from "../../rewards/config.js";

test("GET /config serves levels, enabled actions and enabled badges from the code config", async () => {
  const res = await rewards.request("/config");
  expect(res.status).toBe(200);
  const { data } = (await res.json()) as {
    data: { levels: Array<{ level: number; description: string | null }>; actions: Array<{ type: string }>; badges: Array<{ key: string; category: string }> };
  };
  expect(data.levels.map((l) => l.level)).toEqual(LEVELS.map((l) => l.level).sort((a, b) => a - b));
  expect(data.levels[1]!.description).toBeNull();
  expect(data.actions.map((a) => a.type)).toEqual(ACTIONS.filter((a) => a.enabled).map((a) => a.type).sort());
  expect(data.badges).toHaveLength(BADGES.filter((b) => b.enabled).length);
  expect(Object.keys(data.badges[0]!).sort()).toEqual(["category", "color", "description", "icon", "key", "name"]);
});
