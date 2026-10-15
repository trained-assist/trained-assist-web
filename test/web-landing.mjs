import assert from "node:assert/strict";
import { chromium } from "playwright";
import { readFile } from "node:fs/promises";

const html = await readFile(
  new URL("../src/welcome.html", import.meta.url),
  "utf8",
);
const css = await readFile(
  new URL("../src/welcome.css", import.meta.url),
  "utf8",
);
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1000 },
  });
  await page.route("https://site.test/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/welcome.html")
      return route.fulfill({ contentType: "text/html", body: html });
    if (path === "/welcome.css")
      return route.fulfill({ contentType: "text/css", body: css });
    return route.fulfill({ status: 404, body: "not found" });
  });
  await page.goto("https://site.test/welcome.html");
  assert.match(await page.title(), /Trained Assist/);
  assert.equal(
    await page.getByRole("heading", { name: /ИИ-агент.*для реальных задач/ }).count(),
    1,
  );
  assert.equal(await page.locator(".feature-card").count(), 3);
  assert.equal(
    await page.getByTestId("landing-signup-hero").getAttribute("href"),
    "https://app.trainedassist.store/signup.html",
  );
  await page.getByRole("link", { name: /Выбрать способ работы/ }).click();
  assert.equal(new URL(page.url()).hash, "#how");
  await page.getByText("Это обычный чат с ИИ?").click();
  assert.equal(
    await page.locator(".faq details").first().getAttribute("open"),
    "",
  );

  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 844 });
    await page.goto("https://site.test/welcome.html");
    const dimensions = await page.evaluate(() => ({
      viewport: document.documentElement.clientWidth,
      content: document.documentElement.scrollWidth,
    }));
    assert.ok(
      dimensions.content <= dimensions.viewport,
      `horizontal overflow at ${width}px: ${JSON.stringify(dimensions)}`,
    );
  }
  console.log(
    "PASS: landing content, app CTA, anchor/FAQ interaction, and 390px/320px layouts",
  );
} finally {
  await browser.close();
}
