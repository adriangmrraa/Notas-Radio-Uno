# SPEC 03: Multi-Tenancy del Pipeline y Aislamiento de Datos (Prisma ORM)

> Refactorear el pipeline singleton a multi-instancia, aislar Socket.IO por tenant, y separar archivos por tenant.

---

## Contexto

El `AutoPipeline` actual es un singleton. Los eventos Socket.IO se emiten a todos los clientes. Los archivos se guardan en un directorio compartido. Esta spec lo convierte en multi-tenant donde cada organización tiene su pipeline aislado.

Todas las queries de datos ahora usan **Prisma Client** (definido en SPEC-01). Las funciones que antes usaban `databaseService.ts` ahora importan `prisma` directamente.

---

## 1. PipelineManager — Gestor Multi-Instancia

### `src/server/services/pipelineManager.ts`

Sin cambios respecto a la spec original. El PipelineManager no hace queries directas — delega a servicios que usan Prisma.

---

## 2. Tenant Service con Prisma

### `src/server/services/tenantService.ts`

```typescript
import path from 'path';
import fs from 'fs';
import { prisma } from '../lib/prisma.js';
import { decrypt } from './encryptionService.js';

const PROJECT_ROOT = process.env.PROJECT_ROOT || process.cwd();

export interface TenantCredentials {
    deepseek_api_key?: string;
    gemini_api_key?: string;
    xai_api_key?: string;
    twitter_app_key?: string;
    twitter_app_secret?: string;
    twitter_access_token?: string;
    twitter_access_secret?: string;
    meta_access_token?: string;
    meta_app_id?: string;
    meta_app_secret?: string;
    google_client_email?: string;
    google_private_key?: string;
    google_folder_id?: string;
    webhook_pipeline?: string;
    webhook_nuevo_boton?: string;
    webhook_viejo_boton?: string;
    [key: string]: string | undefined;
}

export async function loadTenantCredentials(tenantId: string): Promise<TenantCredentials> {
    // Cargar credenciales encriptadas via Prisma
    const dbCredentials = await prisma.credential.findMany({
        where: { tenantId, isValid: true },
        select: { name: true, value: true },
    });

    const credentials: TenantCredentials = {};

    for (const cred of dbCredentials) {
        try {
            credentials[cred.name] = decrypt(cred.value);
        } catch (err) {
            console.warn(`[Tenant] Error desencriptando ${cred.name}:`, err);
        }
    }

    // Cargar webhooks desde settings
    const settings = await prisma.setting.findMany({
        where: {
            tenantId,
            key: { startsWith: 'webhook_' },
        },
    });

    for (const setting of settings) {
        if (setting.value) credentials[setting.key] = setting.value;
    }

    return credentials;
}

export function getTenantOutputDir(tenantId: string): string {
    const dir = path.join(PROJECT_ROOT, 'output', tenantId);
    for (const subdir of ['images', 'audio', 'transcriptions']) {
        const fullPath = path.join(dir, subdir);
        if (!fs.existsSync(fullPath)) fs.mkdirSync(fullPath, { recursive: true });
    }
    return dir;
}

export async function getTenant(tenantId: string) {
    return prisma.tenant.findFirst({
        where: { id: tenantId, isActive: true },
    });
}

export async function updateTenant(
    tenantId: string,
    data: { name?: string; platformName?: string; logoUrl?: string; timezone?: string; config?: any }
) {
    return prisma.tenant.update({
        where: { id: tenantId },
        data,
    });
}
```

---

## 3. Refactor de AutoPipeline

Los cambios al `AutoPipeline` se mantienen como en la spec original:

- Constructor recibe `PipelineContext` con `tenantId`, `credentials`, `outputDir`, `socketEmitter`, `onUsageUpdate`
- Todas las llamadas a `io.emit()` → `this.ctx.socketEmitter()`
- Todas las llamadas a DB reciben `this.ctx.tenantId`

**Cambio clave**: Las funciones de DB dentro del pipeline ahora usan Prisma:

```typescript
// ANTES (databaseService.ts):
createPublication({ title, content, ... });

// DESPUÉS (Prisma directo):
import { prisma } from '../lib/prisma.js';

await prisma.publication.create({
    data: {
        tenantId: this.ctx.tenantId,
        title,
        content,
        imagePath: flyerPath,
        imageUrl,
        source: 'pipeline',
        publishResults: publishResults as any,
    },
});

// ANTES:
createTranscription({ text, source: 'pipeline', duration_seconds: duration });

// DESPUÉS:
await prisma.transcription.create({
    data: {
        tenantId: this.ctx.tenantId,
        text: result.text,
        source: 'pipeline',
        durationSeconds: duration,
    },
});

// ANTES:
const config = getActivePipelineConfig();

// DESPUÉS:
const config = await prisma.pipelineConfig.findFirst({
    where: { tenantId: this.ctx.tenantId, isActive: true },
});

// ANTES:
const agents = getAllAgents();

// DESPUÉS:
const agents = await prisma.customAgent.findMany({
    where: { tenantId: this.ctx.tenantId, isEnabled: true },
    orderBy: [{ afterStep: 'asc' }, { position: 'asc' }],
});
```

---

## 4. Socket.IO con Autenticación y Rooms

Sin cambios respecto a la spec original. Socket.IO middleware verifica JWT y hace `socket.join(`tenant:${tenantId}`)`.

---

## 5. Refactor de Rutas con Prisma

### History Routes

```typescript
// GET /api/history/publications
router.get('/publications', async (req, res, next) => {
    try {
        const limit = parseInt(req.query.limit as string) || 50;
        const offset = parseInt(req.query.offset as string) || 0;

        const [publications, total] = await prisma.$transaction([
            prisma.publication.findMany({
                where: { tenantId: req.tenantId! },
                orderBy: { createdAt: 'desc' },
                take: limit,
                skip: offset,
            }),
            prisma.publication.count({ where: { tenantId: req.tenantId! } }),
        ]);

        res.json({ publications, total });
    } catch (error) { next(error); }
});

// DELETE /api/history/publications/:id
router.delete('/publications/:id', async (req, res, next) => {
    try {
        // Verificar que pertenece al tenant
        const pub = await prisma.publication.findFirst({
            where: { id: req.params.id, tenantId: req.tenantId! },
        });
        if (!pub) return res.status(404).json({ error: 'No encontrado' });

        // Eliminar archivo de imagen si existe
        if (pub.imagePath && fs.existsSync(pub.imagePath)) {
            fs.unlinkSync(pub.imagePath);
        }

        await prisma.publication.delete({ where: { id: pub.id } });
        res.json({ message: 'Publicación eliminada' });
    } catch (error) { next(error); }
});
```

### Settings Routes

```typescript
// GET /api/settings/webhooks
router.get('/webhooks', async (req, res, next) => {
    try {
        const settings = await prisma.setting.findMany({
            where: {
                tenantId: req.tenantId!,
                key: { in: ['webhook_nuevo_boton', 'webhook_viejo_boton', 'webhook_tercer_boton', 'webhook_pipeline'] },
            },
        });

        const urls: Record<string, string> = {};
        for (const s of settings) urls[s.key] = s.value || '';
        res.json(urls);
    } catch (error) { next(error); }
});

// POST /api/settings/webhooks
router.post('/webhooks', async (req, res, next) => {
    try {
        const entries = Object.entries(req.body) as [string, string][];

        await prisma.$transaction(
            entries.map(([key, value]) =>
                prisma.setting.upsert({
                    where: { tenantId_key: { tenantId: req.tenantId!, key } },
                    update: { value },
                    create: { tenantId: req.tenantId!, key, value },
                })
            )
        );

        res.json({ message: 'Webhooks guardados' });
    } catch (error) { next(error); }
});
```

### Agent Routes

```typescript
// GET /api/agents
router.get('/', async (req, res, next) => {
    try {
        const agents = await prisma.customAgent.findMany({
            where: { tenantId: req.tenantId! },
            orderBy: [{ afterStep: 'asc' }, { position: 'asc' }],
        });
        res.json({ agents });
    } catch (error) { next(error); }
});

// POST /api/agents
router.post('/', async (req, res, next) => {
    try {
        const agent = await prisma.customAgent.create({
            data: {
                tenantId: req.tenantId!,
                name: req.body.name,
                description: req.body.description,
                systemPrompt: req.body.system_prompt,
                position: req.body.position || 0,
                afterStep: req.body.after_step,
                aiProvider: req.body.ai_provider || 'auto',
                temperature: req.body.temperature || 0.7,
                maxTokens: req.body.max_tokens || 2000,
                tools: req.body.tools || [],
                templateId: req.body.template_id,
            },
        });
        res.status(201).json({ agent });
    } catch (error) { next(error); }
});

// PUT /api/agents/:id
router.put('/:id', async (req, res, next) => {
    try {
        // Verificar que pertenece al tenant
        const existing = await prisma.customAgent.findFirst({
            where: { id: req.params.id, tenantId: req.tenantId! },
        });
        if (!existing) return res.status(404).json({ error: 'Agente no encontrado' });

        const agent = await prisma.customAgent.update({
            where: { id: req.params.id },
            data: req.body,
        });
        res.json({ agent });
    } catch (error) { next(error); }
});

// DELETE /api/agents/:id
router.delete('/:id', async (req, res, next) => {
    try {
        const existing = await prisma.customAgent.findFirst({
            where: { id: req.params.id, tenantId: req.tenantId! },
        });
        if (!existing) return res.status(404).json({ error: 'Agente no encontrado' });

        await prisma.customAgent.delete({ where: { id: req.params.id } });
        res.json({ message: 'Agente eliminado' });
    } catch (error) { next(error); }
});
```

### Pipeline Config Routes

```typescript
// GET /api/pipeline-config
router.get('/', async (req, res, next) => {
    try {
        const config = await prisma.pipelineConfig.findFirst({
            where: { tenantId: req.tenantId!, isActive: true },
        });
        res.json(config || { nodeOrder: DEFAULT_NODE_ORDER });
    } catch (error) { next(error); }
});

// PUT /api/pipeline-config
router.put('/', async (req, res, next) => {
    try {
        const config = await prisma.pipelineConfig.upsert({
            where: {
                // Usar el primero activo o crear uno nuevo
                id: (await prisma.pipelineConfig.findFirst({
                    where: { tenantId: req.tenantId!, isActive: true },
                }))?.id || 'new',
            },
            update: {
                nodeOrder: req.body.node_order,
                name: req.body.name || 'default',
            },
            create: {
                tenantId: req.tenantId!,
                nodeOrder: req.body.node_order,
                name: req.body.name || 'default',
            },
        });
        res.json(config);
    } catch (error) { next(error); }
});

// POST /api/pipeline-config/reset
router.post('/reset', async (req, res, next) => {
    try {
        await prisma.pipelineConfig.deleteMany({
            where: { tenantId: req.tenantId! },
        });
        res.json({ nodeOrder: DEFAULT_NODE_ORDER });
    } catch (error) { next(error); }
});
```

### Meta Routes

```typescript
// Las credenciales Meta ahora se buscan por tenant:

// GET /api/meta/status
router.get('/status', async (req, res, next) => {
    try {
        const tokenCred = await prisma.credential.findFirst({
            where: { tenantId: req.tenantId!, name: 'meta_user_access_token', isValid: true },
        });

        if (!tokenCred) return res.json({ connected: false });

        const assets = await prisma.businessAsset.findMany({
            where: { tenantId: req.tenantId!, isActive: true },
        });

        // ... formato de respuesta igual
    } catch (error) { next(error); }
});

// POST /api/meta/connect
router.post('/connect', async (req, res, next) => {
    // Guardar credenciales con Prisma upsert
    await prisma.credential.upsert({
        where: { tenantId_name: { tenantId: req.tenantId!, name: 'meta_user_access_token' } },
        update: { value: encrypt(longLivedToken), isValid: true },
        create: { tenantId: req.tenantId!, name: 'meta_user_access_token', value: encrypt(longLivedToken), category: 'meta' },
    });
    // ... descubrir assets, guardarlos
});

// POST /api/meta/disconnect
router.post('/disconnect', async (req, res, next) => {
    await prisma.$transaction([
        prisma.credential.updateMany({
            where: { tenantId: req.tenantId!, category: 'meta' },
            data: { isValid: false },
        }),
        prisma.businessAsset.updateMany({
            where: { tenantId: req.tenantId! },
            data: { isActive: false },
        }),
    ]);
    res.json({ message: 'Desconectado' });
});
```

---

## 6. Servir Archivos de Output (sin cambios)

El middleware `serveTenantOutput` no usa DB — se mantiene idéntico.

---

## 7. Testing Checklist

- [ ] Tenant A puede iniciar pipeline sin afectar a Tenant B
- [ ] Prisma queries siempre incluyen `where: { tenantId }`
- [ ] Socket.IO rooms aíslan eventos por tenant
- [ ] Publications/Transcriptions/Agents/Settings filtrados por tenant via Prisma
- [ ] Credenciales Meta aisladas por tenant (Prisma `findFirst` con tenantId)
- [ ] Pipeline config aislado por tenant (Prisma `findFirst` + `upsert`)
- [ ] Archivos output separados por tenant
- [ ] TypeScript valida todos los tipos auto-generados de Prisma
- [ ] Transacciones Prisma (`$transaction`) mantienen consistencia
