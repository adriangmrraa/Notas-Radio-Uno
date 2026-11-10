/**
 * mentionService — menciones y etiquetas por red de PUBLICACIÓN (PG-06).
 *
 * Dominio distinto al de `networkVariantService` (PF-09): PF-09 genera
 * variantes de contenido para 5 redes editoriales (`NetworkVariantKey` —
 * contrato que NO se toca); este servicio compone el TEXTO FINAL que se
 * encola en `publish_jobs` para las redes de publicación de Zernio
 * (`AutoPublishPlatform` — instagram, facebook, tiktok, youtube, linkedin,
 * twitter, threads, pinterest, reddit, bluesky).
 *
 * REGLA DE ORO (misma que PF-09): los handles salen SIEMPRE de
 * `persons.social_links` del tenant — nunca del nombre de la persona ni de
 * lo que pida el LLM. `resolvePublishMentions` reusa `normalizeHandle` de
 * PF-09 y la preferencia `x` > `twitter`; una persona sin handle en la red
 * destino simplemente no se menciona, y una red sin soporte de mención
 * (key ausente en `PUBLISH_MENTION_KEYS`, p. ej. cualquier plataforma
 * fuera del enum editorial) tampoco rompe — devuelve [].
 *
 * `composePublishContent` es pura y determinista: texto base + menciones
 * + hashtags al final, sin duplicar lo que ya está en el texto
 * (case-insensitive, con borde de token a ambos lados), y recorte seguro
 * cuando la plataforma tiene límite de caracteres.
 */
import {
    AUTO_PUBLISH_PLATFORMS,
    type AutoPublishPlatform,
} from './autoPublishService.js';
import {
    normalizeHandle,
    type PersonSocialLinks,
    type ResolvedMention,
} from './networkVariantService.js';

// ---------------------------------------------------------------------------
// Plataformas y keys de social_links
// ---------------------------------------------------------------------------

/** Red de publicación (las 10 editoriales del enum de Zernio). */
export type PublishPlatform = AutoPublishPlatform;
export const PUBLISH_PLATFORMS = AUTO_PUBLISH_PLATFORMS;

/**
 * Keys de `persons.social_links` que aportan handle por red de publicación,
 * EN ORDEN de preferencia (misma convención que NETWORK_HANDLE_KEYS: para
 * X gana `x` sobre `twitter`). Una plataforma fuera del mapa no soporta
 * menciones → la persona no se menciona ahí.
 */
export const PUBLISH_MENTION_KEYS: Record<PublishPlatform, readonly string[]> =
    {
        twitter: ['x', 'twitter'],
        instagram: ['instagram'],
        facebook: ['facebook'],
        linkedin: ['linkedin'],
        youtube: ['youtube'],
        tiktok: ['tiktok'],
        threads: ['threads'],
        pinterest: ['pinterest'],
        reddit: ['reddit'],
        bluesky: ['bluesky'],
    };

/**
 * Límites de caracteres del caption por red (fuente: límites públicos
 * documentados de cada plataforma — X/Twitter 280, Threads 500, Bluesky
 * 300). El repo no tenía constantes de límite; sólo se declara límite
 * donde hay un valor oficial inequívoco: el resto queda sin recorte.
 */
export const PUBLISH_TEXT_LIMITS: Partial<Record<PublishPlatform, number>> = {
    twitter: 280,
    threads: 500,
    bluesky: 300,
};

// ---------------------------------------------------------------------------
// Menciones determinísticas (puras)
// ---------------------------------------------------------------------------

/**
 * Por cada persona, el handle de `platform` = el primer key de
 * `PUBLISH_MENTION_KEYS[platform]` presente y con string usable en
 * `socialLinks` — normalizado a '@handle' vía `normalizeHandle` (PF-09).
 * Sin handle en esa red ⇒ la persona no aparece. Dedupe por handle
 * (case-insensitive, gana el primero). `exclude` filtra por personId
 * (toggle del operador en la previsualización).
 */
export function resolvePublishMentions(
    personsList: readonly PersonSocialLinks[],
    platform: string,
    opts?: { exclude?: ReadonlySet<string> },
): ResolvedMention[] {
    const keys = Object.prototype.hasOwnProperty.call(
        PUBLISH_MENTION_KEYS,
        platform,
    )
        ? PUBLISH_MENTION_KEYS[platform as PublishPlatform]
        : undefined;
    if (!keys || keys.length === 0) return [];

    const seen = new Set<string>();
    const out: ResolvedMention[] = [];

    for (const person of personsList) {
        if (opts?.exclude?.has(person.id)) continue;
        const links =
            person.socialLinks && typeof person.socialLinks === 'object'
                ? (person.socialLinks as Record<string, unknown>)
                : {};

        let handle: string | null = null;
        for (const key of keys) {
            const raw = links[key];
            if (typeof raw !== 'string' || !raw.trim()) continue;
            handle = normalizeHandle(raw);
            if (handle) break;
        }
        if (!handle) continue;

        const dedupeKey = handle.toLowerCase();
        if (seen.has(dedupeKey)) continue;
        seen.add(dedupeKey);

        out.push({ personId: person.id, name: person.name, handle });
    }
    return out;
}

// ---------------------------------------------------------------------------
// Hashtags (puras)
// ---------------------------------------------------------------------------

/**
 * Normaliza un hashtag: '#tag'/'tag'/'##tag' → '#tag'; sin espacios
 * internos, sin diacríticos (NFD) y sólo letras/números/'_'. Devuelve
 * null si no queda nada usable.
 */
export function normalizePublishHashtag(raw: string): string | null {
    let tag = raw.trim().replace(/^#+/, '').trim();
    if (!tag) return null;
    tag = tag.replace(/\s+/g, '');
    tag = tag.normalize('NFD').replace(/\p{Diacritic}/gu, '');
    tag = tag.replace(/[^\p{L}\p{N}_]/gu, '');
    return tag ? `#${tag}` : null;
}

/**
 * Lista → hashtags '#tag' normalizados, sin vacíos ni duplicados
 * (case-insensitive, gana el primero) y en el ORDEN ORIGINAL.
 */
export function normalizePublishHashtags(
    value: readonly unknown[] | undefined,
): string[] {
    if (!Array.isArray(value)) return [];
    const seen = new Set<string>();
    const out: string[] = [];
    for (const item of value) {
        if (typeof item !== 'string') continue;
        const tag = normalizePublishHashtag(item);
        if (!tag) continue;
        const key = tag.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(tag);
    }
    return out;
}

/** Hashtags '#tag' ya presentes en un texto (dedupe + orden de aparición). */
export function extractHashtagsFromText(text: string): string[] {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const match of text.matchAll(/#([\p{L}\p{N}_]+)/gu)) {
        const tag = normalizePublishHashtag(match[1]);
        if (!tag) continue;
        const key = tag.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(tag);
    }
    return out;
}

// ---------------------------------------------------------------------------
// Composición del texto final por red (pura, determinista)
// ---------------------------------------------------------------------------

/** Lo mínimo que compose necesita de una mención resuelta. */
export type ComposeMention = Pick<ResolvedMention, 'handle'>;

export interface ComposePublishContentInput {
    baseText: string;
    /** Plataforma destino — decide el límite de caracteres aplicable. */
    platform: string;
    /** Menciones resueltas (sólo se usa `handle`, ya '@x'). */
    mentions?: readonly ComposeMention[];
    /** Etiquetas crudas (se normalizan acá adentro). */
    hashtags?: readonly string[];
    /**
     * Límite de caracteres. `undefined` ⇒ el de
     * `PUBLISH_TEXT_LIMITS[platform]`; `null` ⇒ sin recorte aunque la
     * plataforma tenga límite.
     */
    limit?: number | null;
}

export interface ComposedPublishContent {
    /** Texto final listo para mandar a la plataforma. */
    text: string;
    /** Handles '@x' efectivamente AGREGADOS al final (no estaban en base). */
    mentions: string[];
    /** '#tag' efectivamente AGREGADOS al final (no estaban en base). */
    hashtags: string[];
    /** true si el límite de la plataforma obligó a recortar el texto base. */
    truncated: boolean;
}

const escapeRe = (s: string): string =>
    s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * ¿El token ya está en el texto? Case-insensitive y con borde de token a
 * ambos lados: '@mar' NO cuenta como presente a '@maria', y 'mail@maria'
 * tampoco cuenta (el char previo es letra — no es una mención real).
 */
export function containsPublishToken(text: string, token: string): boolean {
    return new RegExp(
        `(?<![\\p{L}\\p{N}_@#])${escapeRe(token)}(?![\\p{L}\\p{N}_])`,
        'iu',
    ).test(text);
}

/**
 * Texto final por red: base + '\n\n' + menciones + hashtags (en ese orden,
 * separados por espacio). No duplica tokens ya presentes en el texto base.
 *
 * Recorte cuando hay límite: primero se asegura que la cola entre con al
 * menos '…' de base (se descartan tokens del FINAL de la cola — hashtags
 * primero, menciones después); después se trunca el texto base con '…'
 * para entrar en el límite — el texto base tiene prioridad, la cola se
 * conserva completa mientras quepa.
 */
export function composePublishContent(
    input: ComposePublishContentInput,
): ComposedPublishContent {
    const base = input.baseText.trim();

    // Menciones a agregar: handle normalizado, dedupe, y que no esté ya.
    const seenMentions = new Set<string>();
    const mentionTokens: string[] = [];
    for (const m of input.mentions ?? []) {
        const raw = typeof m?.handle === 'string' ? m.handle : '';
        const handle = normalizeHandle(raw);
        if (!handle) continue;
        const key = handle.toLowerCase();
        if (seenMentions.has(key) || containsPublishToken(base, handle)) {
            continue;
        }
        seenMentions.add(key);
        mentionTokens.push(handle);
    }

    // Hashtags a agregar: normalizados, dedupe, y que no estén ya.
    const hashtagTokens = normalizePublishHashtags(
        input.hashtags as readonly unknown[] | undefined,
    ).filter((tag) => !containsPublishToken(base, tag));

    const limit =
        input.limit === null
            ? null
            : input.limit ??
              (Object.prototype.hasOwnProperty.call(
                  PUBLISH_TEXT_LIMITS,
                  input.platform,
              )
                  ? PUBLISH_TEXT_LIMITS[input.platform as PublishPlatform]!
                  : null);

    const tailTokens = [...mentionTokens, ...hashtagTokens];
    let truncated = false;

    if (limit !== null && limit > 0) {
        // La cola tiene que entrar con al menos 1 char de base ('…'): si
        // ni así cabe, se descartan tokens del final (hashtags → menciones).
        while (tailTokens.length > 0 && tailTokens.join(' ').length + 3 > limit) {
            tailTokens.pop();
        }
    }

    const tail = tailTokens.join(' ');
    let text = tail ? (base ? `${base}\n\n${tail}` : tail) : base;

    if (limit !== null && limit > 0 && text.length > limit) {
        truncated = true;
        const room = limit - (tail ? 2 + tail.length : 0); // '\n\n' + tail
        // room >= 1 garantizado por el while de arriba (o tail vacío → room=limit).
        const kept = base
            .slice(0, Math.max(0, room - 1))
            .replace(/[\s…]+$/u, '');
        const baseOut = `${kept}…`;
        text = tail ? `${baseOut}\n\n${tail}` : baseOut;
    }

    return {
        text,
        mentions: mentionTokens.filter((h) => tailTokens.includes(h)),
        hashtags: hashtagTokens.filter((t) => tailTokens.includes(t)),
        truncated,
    };
}
