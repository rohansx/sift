/**
 * Public API.
 *
 * sift is usable as a library, not just a CLI: the pipeline takes injected
 * providers, so embedding it in an existing service means supplying your own
 * Summarizer/Embedder rather than adopting sift's.
 */

export * from "./types.ts";
export {
  FACET_PRESETS,
  DEFAULT_CONFIG,
  CONFIG_FILENAME,
  ConfigError,
  loadConfig,
  resolveFacets,
  validateConfig,
  validateFacets,
  type SiftConfig,
  type LlmConfig,
  type EmbeddingConfig,
  type PrivacyConfig,
  type LoadConfigOptions,
} from "./config.ts";

export { SiftStore, SCHEMA_VERSION, type ListTracesOptions, type WindowCounts } from "./store/db.ts";
export { windowForTrace, dayWindow } from "./window.ts";

export { ingestOtlpJsonlFile, parseOtlpJsonl, type IngestOptions, type IngestResult } from "./ingest/otlp.ts";

export {
  AnthropicSummarizer,
  OpenAiSummarizer,
  HttpLabeler,
  createSummarizer,
  createLabeler,
  clipTrace,
  parseFacetJson,
  buildFacetPrompt,
} from "./facets/summarize.ts";
export { OpenAICompatEmbedder, HashEmbedder, createEmbedder } from "./embed/index.ts";

export { cosine, cosineDistance, dot, norm, normalize, mean, updateCentroid, nearest } from "./cluster/vectors.ts";
export { discoverClusters, type DiscoveredCluster, type DiscoveryResult, type DiscoveryOptions } from "./cluster/bootstrap.ts";

export {
  ThemeRegistry,
  type AssignResult,
  type AssignPendingResult,
  type StateTransition,
  type RegistryDeps,
} from "./registry/index.ts";

export { computeDeltas, themeSeries, type DeltaReport, type DeltaOptions, type ThemeSeries } from "./delta/index.ts";

export { buildFacetReport, sparkline, formatPercent, type FacetReport, type ThemeRow } from "./report/model.ts";
export { renderThemeMarkdown, renderDeltaMarkdown } from "./report/markdown.ts";
export { renderIssuesList, renderDeltaTerminal } from "./report/terminal.ts";

export {
  exportTheme,
  renderExport,
  toMastraScorerModule,
  toEvalCasesModule,
  toJson,
  toJsonl,
  scorerIdentifier,
  EXPORT_FORMATS,
  type EvalExport,
  type EvalCase,
  type ExportFormat,
} from "./export/evals.ts";

export { runCheck, renderCheck, DEFAULT_FAIL_ON, type CheckOptions, type CheckResult } from "./alert/check.ts";
export {
  pendingAlerts,
  markAlerted,
  WebhookAlerter,
  type Alert,
  type AlertEvent,
  type DeliveryResult,
} from "./alert/webhook.ts";

export { Pseudonymizer, REDACTION_RULES, luhnValid, type RedactionRule, type RedactionMode } from "./privacy/redact.ts";
export { RedactingSummarizer, type GateStats } from "./privacy/gate.ts";

export {
  Pipeline,
  createPipeline,
  createPseudonymizer,
  type PipelineDeps,
  type IngestSummary,
  type SummarizeSummary,
  type AssignSummary,
  type DiscoverySummary,
} from "./pipeline.ts";

export { generateDemoTraces, DEMO_SCENARIOS, type DemoOptions, type DemoData } from "./examples/generate-demo-traces.ts";

// Offline providers. Exported deliberately: running the pipeline with no API
// key is a supported mode, not a testing-only concession.
export {
  KeywordSummarizer,
  ScriptedSummarizer,
  ModeEmbedder,
  RecordingEmbedder,
  StubLabeler,
} from "./testing/fakes.ts";
export { mulberry32 } from "./testing/random.ts";
