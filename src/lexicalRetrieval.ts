/**
 * Deterministic multilingual lexical retrieval for persisted conversation.
 * It uses Unicode normalization, light English/Spanish stemming, exact
 * entities/paths and a deliberately small set of cross-language concepts.
 * It is not a semantic model and never invents text.
 */

export interface LexicalDocument {
  id: number;
  text: string;
}

export interface LexicalHit {
  id: number;
  score: number;
  match: 'exact' | 'morphological' | 'expanded';
  terms: string[];
}

const STOP_WORDS = new Set([
  'about', 'after', 'again', 'also', 'and', 'como', 'con', 'del', 'desde',
  'este', 'esta', 'for', 'from', 'hay', 'into', 'las', 'los', 'para', 'pero',
  'por', 'que', 'the', 'this', 'una', 'unos', 'was', 'were', 'what', 'when',
  'where', 'with', 'you', 'your', 'esto', 'hacer', 'quiero', 'debe', 'deben',
  'should', 'could', 'would', 'tiene', 'tienen', 'solo', 'only',
]);

/** Small language-level concepts, not a domain ontology. */
const CONCEPTS: ReadonlyArray<readonly string[]> = [
  ['offline', 'disconnect', 'disconnected', 'networkless', 'internet', 'desconect', 'desconectado', 'desconectada', 'conexion', 'conexión'],
  ['test', 'testing', 'check', 'verify', 'verification', 'prueba', 'pruebas', 'comprobar', 'verificar', 'validar', 'validacion', 'validación', 'validaciones'],
  ['error', 'failure', 'failed', 'problem', 'bug', 'fallo', 'falla', 'problema', 'defecto'],
  ['memory', 'remember', 'recall', 'retrieve', 'memoria', 'recordar', 'recuperar', 'antecedente'],
  ['permission', 'authorization', 'authority', 'approval', 'permiso', 'autorizacion', 'autorización', 'autoridad', 'aprobacion', 'aprobación'],
  ['file', 'document', 'path', 'archivo', 'fichero', 'documento', 'ruta'],
  ['create', 'add', 'new', 'crear', 'anadir', 'añadir', 'nuevo', 'nueva'],
  ['delete', 'remove', 'drop', 'borrar', 'eliminar', 'quitar'],
  ['local', 'device', 'machine', 'equipo', 'maquina', 'máquina'],
  ['cloud', 'remote', 'nube', 'remoto', 'remota'],
];

const CONCEPT_BY_TERM = new Map<string, string>();
CONCEPTS.forEach((terms, index) => {
  for (const term of terms) {
    const normalized = normalizeWord(term);
    CONCEPT_BY_TERM.set(normalized, `concept:${index}`);
    CONCEPT_BY_TERM.set(stem(normalized), `concept:${index}`);
  }
});

function normalizeWord(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .toLocaleLowerCase('en-US');
}

function stem(word: string): string {
  if (word.length < 5 || /[._/@\\-]/.test(word)) {
    return word;
  }
  const suffixes = [
    'amientos', 'imientos', 'aciones', 'ization', 'isations', 'mente', 'ation',
    'idades', 'imiento', 'amiento', 'ingly', 'edly', 'ando', 'iendo', 'ados',
    'adas', 'idos', 'idas', 'ments', 'ment', 'tion', 'ing', 'ers', 'ies', 'ed',
    'es', 'os', 'as', 's',
  ];
  for (const suffix of suffixes) {
    if (word.endsWith(suffix) && word.length - suffix.length >= 4) {
      return word.slice(0, -suffix.length);
    }
  }
  return word;
}

interface Terms {
  raw: Set<string>;
  stems: Set<string>;
  expanded: Set<string>;
  entities: Set<string>;
  normalized: string;
}

function terms(text: string): Terms {
  const normalized = normalizeWord(text);
  const found = normalized.match(/[\p{L}\p{N}_./@\\-]{3,}/gu) ?? [];
  const parts = found.flatMap((word) => [word, ...word.split(/[._/@\\-]+/).filter((part) => part.length >= 3)]);
  const raw = new Set(parts.filter((word) => !STOP_WORDS.has(word)));
  const stems = new Set([...raw].map(stem));
  const expanded = new Set<string>();
  for (const item of [...raw, ...stems]) {
    const concept = CONCEPT_BY_TERM.get(item) ?? CONCEPT_BY_TERM.get(stem(item));
    if (concept) {
      expanded.add(concept);
    }
  }
  if (/\b(?:sin\s+(?:internet|conexion)|without\s+(?:internet|network))\b/.test(normalized)) {
    expanded.add('concept:0');
  }
  const entities = new Set(found.filter((word) => /[._/@\\-]|\d/.test(word)));
  return { raw, stems, expanded, entities, normalized };
}

function intersection(left: ReadonlySet<string>, right: ReadonlySet<string>): string[] {
  return [...left].filter((item) => right.has(item));
}

/** BM25-like relevance with exact entities weighted above expansions. */
export function rankLexically(queryText: string, documents: readonly LexicalDocument[]): LexicalHit[] {
  const query = terms(queryText);
  const parsed = documents.map((document) => ({ document, terms: terms(document.text) }));
  const queryFeatures = new Set([...query.raw, ...query.stems, ...query.expanded]);
  const df = new Map<string, number>();
  for (const feature of queryFeatures) {
    df.set(feature, parsed.filter((entry) =>
      entry.terms.raw.has(feature) || entry.terms.stems.has(feature) || entry.terms.expanded.has(feature),
    ).length);
  }
  const hits: LexicalHit[] = [];
  for (const entry of parsed) {
    const exact = intersection(query.raw, entry.terms.raw);
    const morphological = intersection(query.stems, entry.terms.stems).filter((item) => !exact.includes(item));
    const expanded = intersection(query.expanded, entry.terms.expanded);
    const entities = intersection(query.entities, entry.terms.entities);
    const matched = new Set([...exact, ...morphological, ...expanded]);
    if (matched.size === 0 && entities.length === 0) {
      continue;
    }
    let score = 0;
    for (const feature of matched) {
      const frequency = df.get(feature) ?? 0;
      const idf = Math.log((documents.length + 1) / (frequency + 1)) + 1;
      const weight = exact.includes(feature) ? 2.5 : morphological.includes(feature) ? 1.5 : 1;
      score += idf * weight;
    }
    score += entities.length * 5;
    if (query.normalized.length >= 8 && entry.terms.normalized.includes(query.normalized)) {
      score += 6;
    }
    score /= 1 + Math.log(1 + Math.max(0, entry.terms.raw.size - 20)) * 0.15;
    hits.push({
      id: entry.document.id,
      score,
      match: exact.length > 0 || entities.length > 0 ? 'exact' : morphological.length > 0 ? 'morphological' : 'expanded',
      terms: [...matched, ...entities].slice(0, 8),
    });
  }
  return hits.sort((left, right) => right.score - left.score || right.id - left.id);
}

function jaccard(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  const common = intersection(a, b).length;
  const union = new Set([...a, ...b]).size;
  return union === 0 ? 0 : common / union;
}

/** Jaccard similarity used only to diversify nearly duplicate excerpts. */
export function lexicalSimilarity(left: string, right: string): number {
  return jaccard(terms(left).stems, terms(right).stems);
}

/**
 * Keep, in the given (ranked) order, up to `max` items that are neither an
 * exact repeat nor near-duplicates (similarity >= `threshold`) of an item
 * already kept. Each text is tokenized once and compared only with the kept
 * items, so a long thread costs linear time instead of quadratic.
 */
export function diverseByLexicalSimilarity<T>(
  items: readonly T[],
  text: (item: T) => string,
  max: number,
  threshold = 0.86,
): T[] {
  const kept: Array<{ item: T; key: string; stems: Set<string> }> = [];
  for (const item of items) {
    if (kept.length >= max) {
      break;
    }
    const value = text(item);
    const key = value.replace(/\s+/g, ' ').trim();
    const stems = terms(value).stems;
    if (kept.some((entry) => entry.key === key || jaccard(entry.stems, stems) >= threshold)) {
      continue;
    }
    kept.push({ item, key, stems });
  }
  return kept.map((entry) => entry.item);
}
