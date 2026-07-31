import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  DEFAULT_CONFIG,
  FACET_PRESETS,
  ConfigError,
  loadConfig,
  resolveFacets,
  validateFacets,
} from "../src/config.ts";

function withTempDir<T>(fn: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "sift-cfg-"));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("facet presets", () => {
  test("ships the four presets the design calls for", () => {
    assert.deepEqual(Object.keys(FACET_PRESETS).sort(), ["chat", "coding", "pipeline", "support"]);
  });

  test("every preset has unique, well-formed facet names and real instructions", () => {
    for (const [preset, facets] of Object.entries(FACET_PRESETS)) {
      assert.ok(facets.length >= 3, `${preset} should have at least 3 facets`);
      const names = facets.map((f) => f.name);
      assert.equal(new Set(names).size, names.length, `${preset} has duplicate facet names`);
      for (const f of facets) {
        assert.match(f.name, /^[a-z][a-z0-9-]*$/, `${preset}.${f.name} is not kebab-case`);
        assert.ok(f.instruction.length > 20, `${preset}.${f.name} instruction is too thin`);
      }
    }
  });

  test("every preset carries an outcome facet", () => {
    // Deltas and eval export both key off "did the agent succeed", so an
    // outcome dimension is not optional in a preset.
    for (const [preset, facets] of Object.entries(FACET_PRESETS)) {
      assert.ok(
        facets.some((f) => f.name === "outcome"),
        `${preset} is missing an outcome facet`,
      );
    }
  });
});

describe("validateFacets", () => {
  test("rejects an empty facet list", () => {
    assert.throws(() => validateFacets([]), ConfigError);
  });

  test("rejects duplicate facet names", () => {
    assert.throws(
      () =>
        validateFacets([
          { name: "goal", instruction: "what did they want, in one sentence" },
          { name: "goal", instruction: "again, in one sentence, for some reason" },
        ]),
      /duplicate facet/i,
    );
  });

  test("rejects names that would break window/column keys", () => {
    assert.throws(() => validateFacets([{ name: "Goal Facet", instruction: "x".repeat(30) }]), /facet name/i);
  });

  test("accepts a well-formed custom facet set", () => {
    const facets = [
      { name: "task", instruction: "what the agent was asked to do, one sentence" },
      { name: "outcome", instruction: "did it succeed, one of completed/partial/failed" },
    ];
    assert.deepEqual(validateFacets(facets), facets);
  });
});

describe("resolveFacets", () => {
  test("resolves a preset name", () => {
    assert.deepEqual(resolveFacets({ ...DEFAULT_CONFIG, preset: "coding" }), FACET_PRESETS.coding);
  });

  test("explicit facets win over the preset", () => {
    const facets = [{ name: "vibes", instruction: "how did the whole thing feel, one phrase" }];
    assert.deepEqual(resolveFacets({ ...DEFAULT_CONFIG, preset: "chat", facets }), facets);
  });

  test("unknown preset is a ConfigError that names the valid ones", () => {
    assert.throws(
      () => resolveFacets({ ...DEFAULT_CONFIG, preset: "nope" }),
      (err: unknown) => {
        assert.ok(err instanceof ConfigError);
        assert.match((err as Error).message, /chat/);
        return true;
      },
    );
  });
});

describe("loadConfig precedence", () => {
  test("returns defaults with no file, env, or overrides", () => {
    const cfg = loadConfig({ cwd: "/nonexistent-dir-for-sift-tests", env: {} });
    assert.equal(cfg.assignThreshold, DEFAULT_CONFIG.assignThreshold);
    assert.equal(cfg.dbPath, DEFAULT_CONFIG.dbPath);
    assert.equal(cfg.preset, "chat");
  });

  test("discovers sift.config.json in cwd", () => {
    withTempDir((dir) => {
      writeFileSync(join(dir, "sift.config.json"), JSON.stringify({ preset: "coding", assignThreshold: 0.8 }));
      const cfg = loadConfig({ cwd: dir, env: {} });
      assert.equal(cfg.preset, "coding");
      assert.equal(cfg.assignThreshold, 0.8);
      // untouched keys keep their defaults
      assert.equal(cfg.minClusterSize, DEFAULT_CONFIG.minClusterSize);
    });
  });

  test("nested provider config merges rather than replaces", () => {
    withTempDir((dir) => {
      writeFileSync(join(dir, "sift.config.json"), JSON.stringify({ llm: { model: "my-model" } }));
      const cfg = loadConfig({ cwd: dir, env: {} });
      assert.equal(cfg.llm.model, "my-model");
      assert.equal(cfg.llm.baseUrl, DEFAULT_CONFIG.llm.baseUrl, "baseUrl should survive a partial llm block");
    });
  });

  test("env beats file", () => {
    withTempDir((dir) => {
      writeFileSync(join(dir, "sift.config.json"), JSON.stringify({ assignThreshold: 0.8, llm: { model: "from-file" } }));
      const cfg = loadConfig({
        cwd: dir,
        env: { SIFT_ASSIGN_THRESHOLD: "0.9", SIFT_LLM_MODEL: "from-env" },
      });
      assert.equal(cfg.assignThreshold, 0.9);
      assert.equal(cfg.llm.model, "from-env");
    });
  });

  test("explicit overrides beat env", () => {
    const cfg = loadConfig({
      cwd: "/nonexistent",
      env: { SIFT_ASSIGN_THRESHOLD: "0.9" },
      overrides: { assignThreshold: 0.5 },
    });
    assert.equal(cfg.assignThreshold, 0.5);
  });

  test("an explicit config path that does not exist is an error, unlike discovery", () => {
    assert.throws(() => loadConfig({ configPath: "/nope/sift.config.json", env: {} }), /not found/i);
  });

  test("malformed config JSON names the file", () => {
    withTempDir((dir) => {
      const p = join(dir, "sift.config.json");
      writeFileSync(p, "{ not json");
      assert.throws(() => loadConfig({ cwd: dir, env: {} }), new RegExp(p.replace(/[/\\]/g, "."), "i"));
    });
  });
});

describe("loadConfig validation", () => {
  const bad: Array<[string, Record<string, unknown>, RegExp]> = [
    ["threshold above 1", { assignThreshold: 1.5 }, /assignThreshold/],
    ["threshold below -1", { assignThreshold: -2 }, /assignThreshold/],
    ["residual share above 1", { rediscoverResidualShare: 4 }, /rediscoverResidualShare/],
    ["min cluster size of 1", { minClusterSize: 1 }, /minClusterSize/],
    ["negative sigma", { deltaSigma: -1 }, /deltaSigma/],
    ["zero embedding dimensions", { embeddings: { dimensions: 0 } }, /dimensions/],
    ["merge threshold above 2", { mergeThreshold: 2.5 }, /mergeThreshold/],
  ];

  for (const [name, overrides, pattern] of bad) {
    test(`rejects ${name}`, () => {
      assert.throws(() => loadConfig({ cwd: "/nonexistent", env: {}, overrides: overrides as never }), pattern);
    });
  }

  test("reports every problem at once rather than one per run", () => {
    assert.throws(
      () => loadConfig({ cwd: "/nonexistent", env: {}, overrides: { assignThreshold: 9, deltaSigma: -3 } as never }),
      (err: unknown) => {
        const msg = (err as Error).message;
        assert.match(msg, /assignThreshold/);
        assert.match(msg, /deltaSigma/);
        return true;
      },
    );
  });

  test("non-numeric env value is rejected with the variable name", () => {
    assert.throws(() => loadConfig({ cwd: "/nonexistent", env: { SIFT_ASSIGN_THRESHOLD: "high" } }), /SIFT_ASSIGN_THRESHOLD/);
  });

  test("validates facets too, so a bad custom facet fails at load", () => {
    assert.throws(
      () => loadConfig({ cwd: "/nonexistent", env: {}, overrides: { facets: [{ name: "BAD NAME", instruction: "x".repeat(40) }] } }),
      /facet name/i,
    );
  });
});

describe("privacy config", () => {
  test("the gate is on by default", () => {
    // Summaries leave the building. A tool that says traces are the most
    // PII-dense artifact you own should not ship with redaction opt-in.
    const cfg = loadConfig({ cwd: "/nonexistent", env: {} });
    assert.equal(cfg.privacy.mode, "pseudonymize");
    assert.equal(cfg.privacy.scope, "trace");
  });

  test("mode, scope and salt come from the environment", () => {
    const cfg = loadConfig({
      cwd: "/nonexistent",
      env: { SIFT_PRIVACY_MODE: "mask", SIFT_PRIVACY_SCOPE: "global", SIFT_PRIVACY_SALT: "pepper" },
    });
    assert.equal(cfg.privacy.mode, "mask");
    assert.equal(cfg.privacy.scope, "global");
    assert.equal(cfg.privacy.salt, "pepper");
  });

  test("an unknown mode or scope is rejected", () => {
    assert.throws(() => loadConfig({ cwd: "/nonexistent", env: { SIFT_PRIVACY_MODE: "kinda" } }), /privacy\.mode/);
    assert.throws(() => loadConfig({ cwd: "/nonexistent", env: { SIFT_PRIVACY_SCOPE: "world" } }), /privacy\.scope/);
  });

  test("an unknown rule name is rejected at load, not at first trace", () => {
    assert.throws(
      () => loadConfig({ cwd: "/nonexistent", env: {}, overrides: { privacy: { rules: ["emails"] } } as never }),
      /emails/,
    );
  });

  test("global scope without a salt is refused", () => {
    // Unsalted global tokens are a rainbow table over your users' emails.
    assert.throws(
      () => loadConfig({ cwd: "/nonexistent", env: { SIFT_PRIVACY_SCOPE: "global" } }),
      /salt/i,
    );
  });
});

describe("loadConfig env surface", () => {
  test("maps every documented env var", () => {
    const cfg = loadConfig({
      cwd: "/nonexistent",
      env: {
        SIFT_DB: "/tmp/x.db",
        SIFT_PRESET: "support",
        SIFT_ASSIGN_THRESHOLD: "0.66",
        SIFT_RESIDUAL_SHARE: "0.2",
        SIFT_MIN_CLUSTER_SIZE: "7",
        SIFT_MERGE_THRESHOLD: "0.4",
        SIFT_DELTA_SIGMA: "3",
        SIFT_LLM_PROVIDER: "openai",
        SIFT_LLM_BASE_URL: "http://localhost:1234",
        SIFT_LLM_API_KEY: "k1",
        SIFT_LLM_MODEL: "m1",
        SIFT_LLM_MAX_TOKENS: "4000",
        SIFT_EMBED_PROVIDER: "hash",
        SIFT_EMBED_BASE_URL: "http://localhost:5678",
        SIFT_EMBED_API_KEY: "k2",
        SIFT_EMBED_MODEL: "m2",
        SIFT_EMBED_DIMENSIONS: "256",
      },
    });
    assert.equal(cfg.dbPath, "/tmp/x.db");
    assert.equal(cfg.preset, "support");
    assert.equal(cfg.assignThreshold, 0.66);
    assert.equal(cfg.rediscoverResidualShare, 0.2);
    assert.equal(cfg.minClusterSize, 7);
    assert.equal(cfg.mergeThreshold, 0.4);
    assert.equal(cfg.deltaSigma, 3);
    assert.deepEqual(cfg.llm, {
      provider: "openai",
      baseUrl: "http://localhost:1234",
      apiKey: "k1",
      model: "m1",
      maxTokens: 4000,
    });
    assert.deepEqual(cfg.embeddings, {
      provider: "hash",
      baseUrl: "http://localhost:5678",
      apiKey: "k2",
      model: "m2",
      dimensions: 256,
    });
  });

  test("llm.maxTokens is unset by default and refuses a nonsense value", () => {
    // Unset means "scale it by facet count"; a number means the operator knows
    // something the scaling cannot see, e.g. that the model thinks before it
    // answers and spends this budget doing it.
    assert.equal(loadConfig({ cwd: "/nonexistent", env: {} }).llm.maxTokens, undefined);
    assert.throws(
      () => loadConfig({ cwd: "/nonexistent", env: { SIFT_LLM_MAX_TOKENS: "1" } }),
      /llm.maxTokens must be an integer >= 16/,
    );
  });

  test("defaults do not leak process env into a caller-supplied env", () => {
    const cfg = loadConfig({ cwd: "/nonexistent", env: {} });
    assert.equal(cfg.llm.apiKey, undefined);
    assert.equal(cfg.embeddings.apiKey, undefined);
  });
});
