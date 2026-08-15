import { Context } from "@deepseek-ai/cordis";
//#region src/index.d.ts
declare const name = "cc-import";
declare const inject: readonly ["systemPrompt", "sandboxPolicy", "tools", "webServer"];
declare function apply(ctx: Context): void;
//#endregion
export { apply, inject, name };