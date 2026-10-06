import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import postcss from "postcss";

const priorities = [".primary-button", ".secondary-button", ".danger-button"];
const dimensions = /^(?:margin(?:-.+)?|padding(?:-.+)?|(?:min-|max-)?(?:width|height)|font-size|line-height|border-radius)$/;

function violations(css) {
  const found = [];
  postcss.parse(css).walkRules((rule) => {
    const selectors = rule.selectors.map((selector) => selector.trim());
    const bases = priorities.filter((priority) => selectors.includes(priority));
    rule.walkDecls((decl) => {
      const unequalBase = bases.length>0 && bases.length<priorities.length && dimensions.test(decl.prop) && !(decl.prop.startsWith("margin") && /^0(?:px)?$/.test(decl.value));
      const primaryOnlyFullWidth = /^(width|inline-size)$/.test(decl.prop) && decl.value==='100%' && selectors.some(s=>s.includes('.primary-button')) && !selectors.some(s=>s.includes('.secondary-button') || s.includes('.danger-button'));
      if (unequalBase || primaryOnlyFullWidth) {
        found.push(`${rule.selector}: ${decl.prop}:${decl.value} (line ${decl.source?.start?.line})`);
      }
    });
  });
  return found;
}

test("button priority classes cannot introduce different global geometry", () => {
  const css = readFileSync(new URL("../../apps/web/src/styles.css", import.meta.url), "utf8");
  assert.deepEqual(violations(css), [], "AGENTS.md: priority is colour/order, never larger geometry");
});

test("policy rejects old margin/stretch and mobile full-width regressions", () => {
  assert.equal(violations(".secondary-button { margin-top:14px } @media(max-width:900px){ .primary-button {width:100%} }").length, 2);
  assert.equal(violations(".primary-button {min-height:56px;font-size:20px}").length, 2);
  assert.equal(violations(".new-footer .primary-button {width:100%}").length, 1);
});

test("policy allows shared dimensions and context-specific whole groups", () => {
  assert.deepEqual(violations(".primary-button,.secondary-button,.danger-button { min-height:40px; margin:0; padding:0 14px } .primary-button {color:white} .actions > button {width:100%} .actions .primary-button,.actions .secondary-button{min-height:34px}"), []);
});
