import type { DomainLabel } from "./schema.js";

/**
 * One row per domain. Every list is matched case-insensitively:
 * - `extensions`: a touched file's extension (`.tsx`), or a whole basename
 *   with no extension (`dockerfile`).
 * - `files`: a touched file's basename matches the pattern.
 * - `dirs`: any directory segment of a touched file's repo-relative path, or
 *   of the session's repo-relative cwd, equals one of these.
 * - `keywords`: whole words (or phrases) in the user's prompts.
 *
 * To teach the classifier something new, add to this table; `classify.ts`
 * holds no domain knowledge of its own.
 */
export type DomainRule = {
  label: Exclude<DomainLabel, "unknown">;
  extensions: readonly string[];
  files: readonly RegExp[];
  dirs: readonly string[];
  keywords: readonly string[];
};

// biome-ignore format: a dense table is easier to scan and extend.
export const DOMAIN_RULES: readonly DomainRule[] = [
  {
    label: "frontend",
    extensions: [".tsx", ".jsx", ".vue", ".svelte", ".astro", ".css", ".scss", ".sass", ".less", ".html"],
    files: [/^(vite|next|nuxt|svelte|astro|tailwind|postcss|webpack)\.config\./, /^index\.html$/],
    dirs: ["frontend", "web", "webapp", "client", "ui", "components", "pages", "styles", "public", "assets", "views"],
    keywords: [
      "frontend", "ui", "ux", "react", "vue", "svelte", "css", "tailwind", "component", "components",
      "button", "layout", "page", "browser", "dom", "responsive", "styling", "viewer", "vite", "nextjs",
      "dark mode", "modal", "sidebar",
    ],
  },
  {
    label: "backend",
    extensions: [".go", ".rs", ".java", ".kt", ".rb", ".php", ".cs", ".ex", ".exs", ".proto"],
    files: [/^(server|app|main|routes?|handlers?|middleware)\.(ts|js|mjs|py|go)$/],
    dirs: ["backend", "server", "api", "routes", "handlers", "controllers", "services", "middleware", "daemon", "cmd"],
    keywords: [
      "backend", "api", "endpoint", "server", "route", "handler", "middleware", "auth", "websocket",
      "http", "rest", "graphql", "grpc", "daemon", "database", "request", "response", "rate limit",
    ],
  },
  {
    label: "ml",
    extensions: [".ipynb", ".pt", ".pth", ".ckpt", ".onnx", ".safetensors", ".h5", ".gguf"],
    files: [/^(train|training|finetune|fine_tune|model|inference|eval)\w*\.py$/],
    dirs: ["ml", "training", "train", "models", "checkpoints", "experiments", "notebooks", "inference"],
    keywords: [
      "ml", "model", "training", "train", "fine-tune", "finetune", "epoch", "loss", "pytorch", "torch",
      "tensorflow", "jax", "embedding", "embeddings", "inference", "neural", "transformer", "gpu",
      "cuda", "llm", "gradient", "hyperparameter", "checkpoint", "classifier",
    ],
  },
  {
    label: "data",
    extensions: [".sql", ".csv", ".tsv", ".parquet", ".avro", ".ipynb", ".jsonl"],
    files: [/^dbt_project\.yml$/, /^(etl|ingest|pipeline)\w*\.py$/],
    dirs: ["data", "etl", "pipelines", "dbt", "analytics", "warehouse", "queries", "sql", "migrations"],
    keywords: [
      "data", "sql", "query", "queries", "etl", "pipeline", "dataframe", "pandas", "polars", "csv",
      "parquet", "warehouse", "dbt", "analytics", "spark", "airflow", "bigquery", "snowflake",
      "dashboard", "schema", "join", "aggregate",
    ],
  },
  {
    label: "infra",
    extensions: [".tf", ".tfvars", ".hcl", ".nix", "dockerfile", "makefile", "procfile"],
    files: [/^docker-compose.*\.ya?ml$/, /^compose\.ya?ml$/, /^chart\.yaml$/, /^values.*\.ya?ml$/, /^\.gitlab-ci\.yml$/, /^dockerfile\./],
    dirs: [".github", "workflows", "infra", "infrastructure", "terraform", "k8s", "kubernetes", "helm", "deploy", "deployment", "ansible", "docker", ".circleci", "ops"],
    keywords: [
      "infra", "deploy", "deployment", "docker", "dockerfile", "container", "kubernetes", "k8s", "helm",
      "terraform", "ci", "github actions", "workflow", "nginx", "aws", "gcp", "azure", "cluster",
      "ansible", "devops", "provisioning",
    ],
  },
];
