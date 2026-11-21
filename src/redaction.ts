// Block a file in full when the original project's sensitive-text checks match.
const PREFIXED_ASSIGNMENT_PATTERN =
  /(?<![A-Za-z0-9_-])(["']?)(_*[A-Za-z][A-Za-z0-9_-]*)\1(\s*[:=]\s*)("(?:\\.|[^"\\\r\n])*"|'(?:\\.|[^'\\\r\n])*'|(?:Bearer|Basic)\s+[^\s,;]+|[^\s,;]*)/gi;
const CLI_OPTION_PATTERN =
  /(?<![A-Za-z0-9_-])(--)([A-Za-z][A-Za-z0-9_-]*)(?:(\s*=\s*)("(?:\\.|[^"\\\r\n])*"|'(?:\\.|[^'\\\r\n])*'|(?:Bearer|Basic)[\t ]+[^\s,;]+|[^\s,;]*)|([\t ]+)("(?:\\.|[^"\\\r\n])*"|'(?:\\.|[^'\\\r\n])*'|(?:Bearer|Basic)[\t ]+[^\s,;]+|(?!--[A-Za-z])[^\s,;]+))?/gi;
const STANDALONE_CREDENTIAL_PATTERN =
  /(?<![A-Za-z0-9_-])(Bearer|Basic)([\t ]+)([A-Za-z0-9._~+/-]+=*)(?=$|[\s,;"')\]}])/gi;
const SENSITIVE_ASSIGNMENT_DETECT_PATTERN =
  /(?<![A-Za-z0-9_-])(["']?)(access[_ -]?token|refresh[_ -]?token|id[_ -]?token|token|password|passwd|credentials?|client[_ -]?secret|consumer[_ -]?secret|secret|x[-_ ]?api[_ -]?key|api[_ -]?key|private[_ -]?key)\1\s*[:=]/i;
const AUTHORIZATION_ASSIGNMENT_DETECT_PATTERN =
  /(?<![A-Za-z0-9_-])(["']?)authorization\1\s*[:=]/i;
const COOKIE_ASSIGNMENT_DETECT_PATTERN =
  /(?<![A-Za-z0-9_-])(["']?)(?:set[-_ ]?)?cookie\1\s*[:=]/i;
const EMPTY_STANDALONE_CREDENTIAL_DETECT_PATTERN =
  /(?<![A-Za-z0-9_-])(?:Bearer|Basic)[\t ]+(?=$|[,;"')\]}])/i;
const PRIVATE_KEY_BEGIN_DETECT_PATTERN =
  /-----BEGIN (?:[A-Z0-9]+ )?PRIVATE KEY(?:-----)?/i;
const PROVIDER_TOKEN_SOURCE = [
  "gh[pousr]_[A-Za-z0-9]{20,}",
  "github_pat_[A-Za-z0-9_]{20,}",
  "glpat-[A-Za-z0-9_-]{16,}",
  "(?:AKIA|ASIA|ABIA|ACCA)[0-9A-Z]{16}",
  "xox[abopsr]-[A-Za-z0-9-]{10,}",
  "AIza[A-Za-z0-9_-]{35}",
  "GOCSPX-[A-Za-z0-9_-]{20,}",
  "npm_[A-Za-z0-9]{20,}",
  "hf_[A-Za-z0-9]{30,}",
  "SG\\.[A-Za-z0-9_-]{20,}\\.[A-Za-z0-9_-]{20,}",
  "sk-ant-[A-Za-z0-9_-]{20,}",
  "sk-proj-[A-Za-z0-9_-]{20,}",
  "sk-[A-Za-z0-9]{32,}",
  "eyJ[A-Za-z0-9_-]{8,}\\.eyJ[A-Za-z0-9_-]{8,}\\.[A-Za-z0-9_-]{8,}"
].join("|");
const PROVIDER_TOKEN_DETECT_PATTERN = new RegExp(
  `(?<![A-Za-z0-9_-])(?:${PROVIDER_TOKEN_SOURCE})`
);
const NETRC_MACHINE_DIRECTIVE =
  "machine[\\t ]+(?:localhost|[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)+)";
const NETRC_DIRECTIVE_GAP = "(?:[\\t ]+|\\r?\\n[+-]?[\\t ]*)";
const NETRC_MACHINE_START =
  `(?:(?<![A-Za-z0-9_-])${NETRC_MACHINE_DIRECTIVE}` +
  `|(?<![^\\r\\n])[+-][\\t ]*${NETRC_MACHINE_DIRECTIVE})`;
const NETRC_SUBDIRECTIVE =
  `(?:${NETRC_DIRECTIVE_GAP}(?:login|account|port|protocol)[\\t ]+\\S+)`;
const NETRC_CREDENTIAL_SOURCE =
  `((?:${NETRC_MACHINE_START}${NETRC_SUBDIRECTIVE}*` +
  `|(?<![^\\r\\n])[+-]?[\\t ]*default${NETRC_SUBDIRECTIVE}+)` +
  `${NETRC_DIRECTIVE_GAP}password(?![A-Za-z0-9_-]))` +
  "(?:([\\t ]+)(\\S+))?";
const NETRC_CREDENTIAL_DETECT_PATTERN = new RegExp(NETRC_CREDENTIAL_SOURCE, "i");

function normalizeAssignmentKey(key: string): string {
  return key
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase()
    .replace(/[\s-]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+/, "");
}

function isSensitiveAssignmentKey(key: string): boolean {
  const normalized = normalizeAssignmentKey(key);
  if (normalized === "color_token" || normalized === "public_key") {
    return false;
  }
  const segments = normalized.split("_");
  return segments.some((segment) => [
    "authorization",
    "cookie",
    "credential",
    "credentials",
    "password",
    "passwd",
    "secret",
    "token"
  ].includes(segment)) || /(?:^|_)(?:api_key|private_key)$/u.test(normalized);
}

function isBasicCredential(candidate: string): boolean {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(candidate)) {
    return false;
  }

  const decoded = Buffer.from(candidate, "base64");
  const canonicalCandidate = candidate.replace(/=+$/, "");
  const canonicalDecoded = decoded.toString("base64").replace(/=+$/, "");
  return canonicalDecoded === canonicalCandidate && decoded.includes(0x3a);
}

function isStandaloneCredential(scheme: string, candidate: string): boolean {
  return scheme.toLowerCase() === "bearer" || isBasicCredential(candidate);
}

function containsStandaloneCredential(value: string, filename: boolean): boolean {
  for (const match of value.matchAll(STANDALONE_CREDENTIAL_PATTERN)) {
    const scheme = match[1];
    const candidate = match[3];
    if (scheme !== undefined && candidate !== undefined && (filename || isStandaloneCredential(scheme, candidate))) {
      return true;
    }
  }

  return false;
}

// Case variations can erase a camel-case identifier boundary in a filename.
const FILENAME_CREDENTIAL_KEY = /authorization|cookie|credentials?|password|passwd|secret|token|apikey|privatekey/u;

function isSensitiveFilenameKey(key: string): boolean {
  return FILENAME_CREDENTIAL_KEY.test(key.replace(/[_-]/gu, ""));
}

function containsSensitiveAssignment(value: string, filename: boolean): boolean {
  for (const match of value.matchAll(PREFIXED_ASSIGNMENT_PATTERN)) {
    const key = match[2];
    if (key !== undefined && (filename ? isSensitiveFilenameKey(key) : isSensitiveAssignmentKey(key))) {
      return true;
    }
  }
  return false;
}

function containsSensitiveCliOption(value: string, filename: boolean): boolean {
  for (const match of value.matchAll(CLI_OPTION_PATTERN)) {
    const key = match[2];
    if (key !== undefined && (filename ? isSensitiveFilenameKey(key) : isSensitiveAssignmentKey(key))) {
      return true;
    }
  }
  return false;
}

const CREDENTIAL_URL = /[a-z][a-z0-9+.-]{0,30}:\/\/[^\s\/@:]+:[^\s\/@]+@/iu;

const FILENAME_PROVIDER_TOKEN_PATTERN = new RegExp(PROVIDER_TOKEN_SOURCE, "iu");

function containsSensitiveValue(value: string, filename: boolean): boolean {
  return PRIVATE_KEY_BEGIN_DETECT_PATTERN.test(value) ||
    SENSITIVE_ASSIGNMENT_DETECT_PATTERN.test(value) ||
    containsSensitiveAssignment(value, filename) ||
    AUTHORIZATION_ASSIGNMENT_DETECT_PATTERN.test(value) ||
    COOKIE_ASSIGNMENT_DETECT_PATTERN.test(value) ||
    containsSensitiveCliOption(value, filename) ||
    containsStandaloneCredential(value, filename) ||
    EMPTY_STANDALONE_CREDENTIAL_DETECT_PATTERN.test(value) ||
    (filename ? FILENAME_PROVIDER_TOKEN_PATTERN : PROVIDER_TOKEN_DETECT_PATTERN).test(value) ||
    NETRC_CREDENTIAL_DETECT_PATTERN.test(value) ||
    CREDENTIAL_URL.test(value);
}

export function containsSensitiveText(value: string): boolean {
  return containsSensitiveValue(value, false);
}

export function containsSensitiveFilename(foldedName: string): boolean {
  return containsSensitiveValue(foldedName, true);
}
