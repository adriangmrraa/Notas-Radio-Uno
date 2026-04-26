import { eq, and, sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import { guestDossiers } from '../db/schema/dossiers.js';
import { guests } from '../db/schema/guests.js';
import { programs } from '../db/schema/programs.js';
import { chatCompletion, extractJSON } from './aiService.js';
import { searchAndEnrich } from './searchService.js';
import type { DossierContent } from '../../shared/types.js';

// ---------------------------------------------------------------------------
// Dossier Generation
// ---------------------------------------------------------------------------

/**
 * Genera un dossier de investigacion para un invitado usando busqueda web + IA.
 */
export async function generateGuestDossier(
  guestId: string,
  tenantId: string,
): Promise<{ id: string; status: string }> {
  // 1. Fetch guest + program info
  const [guest] = await db
    .select()
    .from(guests)
    .where(and(eq(guests.id, guestId), eq(guests.tenantId, tenantId)))
    .limit(1);

  if (!guest) throw new Error('Invitado no encontrado');

  const [program] = await db
    .select({ name: programs.name })
    .from(programs)
    .where(eq(programs.id, guest.programId))
    .limit(1);

  const programName = program?.name || 'el programa';

  // 2. Create dossier record in 'generating' status
  const [dossier] = await db
    .insert(guestDossiers)
    .values({
      guestId: guest.id,
      tenantId,
      programId: guest.programId,
      guestName: guest.name,
      scheduledDate: guest.scheduledDate,
      status: 'generating',
    })
    .returning({ id: guestDossiers.id });

  // 3. Run async generation (don't await — let it run in background)
  runDossierGeneration(dossier.id, guest, programName).catch((err) => {
    console.error(`[Dossier] Error generando dossier para ${guest.name}:`, err);
  });

  return { id: dossier.id, status: 'generating' };
}

/**
 * Background: busca en la web y genera el dossier con IA.
 */
async function runDossierGeneration(
  dossierId: string,
  guest: { name: string; role: string; bio: string | null },
  programName: string,
): Promise<void> {
  try {
    // Step 1: Web search
    const searchQueries = [
      `"${guest.name}" ${guest.role}`,
      `"${guest.name}" declaraciones recientes`,
      `"${guest.name}" entrevista noticias`,
    ];

    console.log(`[Dossier] Buscando info sobre "${guest.name}"...`);
    const searchResults = await searchAndEnrich(searchQueries);

    const searchContext = searchResults
      .map((r) => `- ${r.title}: ${r.content || r.snippet}`)
      .join('\n');

    // Step 2: Generate dossier with AI
    const systemPrompt = `Sos un productor periodistico experimentado. Prepara un dossier completo sobre este invitado que participara en el programa "${programName}".

Invitado: ${guest.name}
Rol: ${guest.role}
Bio conocida: ${guest.bio || 'No disponible'}

Informacion encontrada en la web:
${searchContext || 'No se encontro informacion reciente.'}

Genera un JSON con esta estructura exacta:
{
  "summary": "Resumen de 2-3 oraciones sobre quien es",
  "bio": "Biografia completa con datos relevantes",
  "recentActivity": ["Declaracion o actividad reciente 1", "..."],
  "controversies": ["Controversia o tema sensible 1", "..."],
  "suggestedQuestions": ["Pregunta sugerida 1", "Pregunta 2", "..."],
  "keyFacts": ["Dato clave 1", "Dato 2", "..."],
  "relatedTopics": ["Tema relacionado 1", "..."],
  "talkingPoints": ["Punto de conversacion 1", "..."]
}

REGLAS:
- Genera al menos 5 preguntas sugeridas, variadas y relevantes
- Las preguntas deben ser incisivas pero respetuosas
- Si no hay controversias, indica "Sin controversias conocidas"
- Los talking points son sugerencias para el conductor durante la entrevista
- Todo en espanol rioplatense`;

    console.log(`[Dossier] Generando dossier con IA para "${guest.name}"...`);
    const result = await chatCompletion({
      systemPrompt,
      userPrompt: `Genera el dossier completo para ${guest.name} (${guest.role}) en formato JSON.`,
      temperature: 0.4,
      maxTokens: 3000,
      jsonMode: true,
    });

    const parsed = extractJSON(result.text) as DossierContent | null;

    if (!parsed || !parsed.summary) {
      throw new Error('La IA no devolvio un dossier valido');
    }

    // Ensure all arrays exist
    const content: DossierContent = {
      summary: parsed.summary || '',
      bio: parsed.bio || '',
      recentActivity: parsed.recentActivity || [],
      controversies: parsed.controversies || [],
      suggestedQuestions: parsed.suggestedQuestions || [],
      keyFacts: parsed.keyFacts || [],
      relatedTopics: parsed.relatedTopics || [],
      talkingPoints: parsed.talkingPoints || [],
    };

    // Step 3: Save to DB
    await db
      .update(guestDossiers)
      .set({
        content: content,
        status: 'ready',
        generatedAt: new Date(),
      })
      .where(eq(guestDossiers.id, dossierId));

    console.log(`[Dossier] Dossier listo para "${guest.name}" (${content.suggestedQuestions.length} preguntas)`);
  } catch (err) {
    console.error(`[Dossier] Error en generacion:`, err);
    await db
      .update(guestDossiers)
      .set({ status: 'error' })
      .where(eq(guestDossiers.id, dossierId));
  }
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

/**
 * Obtiene el dossier mas reciente de un invitado.
 */
export async function getLatestDossier(guestId: string, tenantId: string) {
  const [dossier] = await db
    .select()
    .from(guestDossiers)
    .where(and(eq(guestDossiers.guestId, guestId), eq(guestDossiers.tenantId, tenantId)))
    .orderBy(sql`${guestDossiers.createdAt} DESC`)
    .limit(1);

  return dossier || null;
}

/**
 * Lista dossiers por programa y fecha.
 */
export async function listDossiers(
  tenantId: string,
  filters: { programId?: string; date?: string },
) {
  const conditions = [eq(guestDossiers.tenantId, tenantId)];

  if (filters.programId) {
    conditions.push(eq(guestDossiers.programId, filters.programId));
  }
  if (filters.date) {
    conditions.push(eq(guestDossiers.scheduledDate, filters.date));
  }

  return db
    .select()
    .from(guestDossiers)
    .where(and(...conditions))
    .orderBy(sql`${guestDossiers.createdAt} DESC`);
}

// ---------------------------------------------------------------------------
// Automatic generation — check for guests scheduled tomorrow without dossier
// ---------------------------------------------------------------------------

let dossierCheckInterval: ReturnType<typeof setInterval> | null = null;

/**
 * Inicializa el chequeo automatico de dossiers cada hora.
 * Busca invitados programados para manana que no tienen dossier.
 */
export function initDossierScheduler(): void {
  if (dossierCheckInterval) clearInterval(dossierCheckInterval);

  // Run every hour
  dossierCheckInterval = setInterval(() => {
    checkAndGenerateDossiers().catch((err) => {
      console.error('[Dossier] Error en chequeo automatico:', err);
    });
  }, 60 * 60 * 1000); // 1 hour

  // Also run once on startup (after 30s delay to let DB connect)
  setTimeout(() => {
    checkAndGenerateDossiers().catch((err) => {
      console.error('[Dossier] Error en chequeo inicial:', err);
    });
  }, 30_000);

  console.log('[Dossier] Scheduler inicializado — chequeo cada 1h');
}

async function checkAndGenerateDossiers(): Promise<void> {
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  const tomorrowStr = tomorrow.toISOString().split('T')[0];

  // Find guests scheduled for tomorrow
  const scheduledGuests = await db
    .select({
      id: guests.id,
      tenantId: guests.tenantId,
      name: guests.name,
    })
    .from(guests)
    .where(
      and(
        eq(guests.scheduledDate, tomorrowStr),
        eq(guests.isActive, true),
      ),
    );

  if (scheduledGuests.length === 0) return;

  console.log(`[Dossier] ${scheduledGuests.length} invitados programados para manana (${tomorrowStr})`);

  for (const guest of scheduledGuests) {
    // Check if dossier already exists
    const existing = await getLatestDossier(guest.id, guest.tenantId);
    if (existing) continue;

    console.log(`[Dossier] Generando dossier automatico para "${guest.name}"`);
    try {
      await generateGuestDossier(guest.id, guest.tenantId);
    } catch (err) {
      console.error(`[Dossier] Error al generar dossier para "${guest.name}":`, err);
    }
  }
}
