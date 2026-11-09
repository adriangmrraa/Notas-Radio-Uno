# Spec: image-model-registry — Imágenes multi-modelo por tenant y plan (Tanda T3)

## Propósito

Registry de modelos de generación de imagen (`image_models`: Gemini flash-image, GPT Image, Ideogram, FLUX, Recraft…) con default por tenant, gating por plan y cadena de fallback — reemplazando la elección rígida actual (Gemini + Grok fallback hardcodeado).

## Actores

- Tenant (elige su modelo default dentro de lo que su plan habilita).
- Plataforma/super-admin (registra modelos, define gating por plan y costos).
- Generadores de assets (flyers, quote-cards, fondos) que resuelven el modelo vía registry.

## Comportamiento observable

### Requirement: Registry declarativo de modelos

El sistema MUST mantener un catálogo `image_models` (proveedor, identificador de modelo, capacidades: texto/flyer/fotorrealista/vector, costo estimado, estado habilitado) configurable sin cambiar el código que genera imágenes.

#### Scenario: Agregar un modelo nuevo

- GIVEN Ideogram habilitado en el registry
- WHEN el tenant lo elige como default
- THEN los flyers se generan con Ideogram sin tocar el pipeline

### Requirement: Default por tenant dentro del plan

El tenant MUST poder elegir su modelo de imagen por defecto entre los habilitados para su plan (`plans.features`/`imageModels` + gating de feature-flags). Si no elige, aplica el default del plan/plataforma.

#### Scenario: Creator vs Network

- GIVEN plan Creator con [gemini] y plan Network con [gemini, gpt-image, ideogram, flux]
- WHEN cada uno ve el selector de modelo
- THEN Creator solo puede elegir Gemini; Network ve el catálogo completo

### Requirement: Fallback automático

Si el modelo elegido falla o excede rate limit, el sistema MUST reintentar con el siguiente modelo habilitado del plan en orden de preferencia, registrando el fallback en el asset/log.

#### Scenario: Gemini cae → fallback a GPT Image

- GIVEN default GPT Image que devuelve error 5xx
- WHEN se genera un flyer
- THEN se produce con el fallback configurado y el asset queda marcado con el modelo efectivamente usado

### Requirement: Uso por caso, no solo global

El registry SHOULD permitir selección por caso (fondo de flyer vs ilustración de nota vs quote-card) via configuración del perfil editorial/formato — opcional v1, obligatorio el default global.

#### Scenario: Ideogram solo para placas con texto

- GIVEN config "tipografía pesada → ideogram" en el perfil
- WHEN se genera una placa con mucho texto
- THEN usa Ideogram aunque el default global sea Gemini

## Datos involucrados (conceptual)

- `image_models`: key, provider, capabilities jsonb, costPerImage?, isEnabled, planGating.
- `tenants.config`/`editorial_profiles`: default model + overrides por caso.
- Credenciales por proveedor (env/vault — BYOK post-launch, A-5).

## Errores y edge cases

- Proveedor sin credenciales → modelo `isEnabled=false` o excluido del resolver con warning.
- Todos los modelos fallan → asset queda `error` con causa; nunca publica imagen rota.
- Modelo elegido deshabilitado después → resuelve al siguiente habilitado y avisa al tenant.
- Costo por modelo → se registra en métricas de costo IA (go-live-ops/PI-03).

## Trazabilidad

PF-08, PE-01 (capa de proveedores), PI-03 (costo). Depende de feature-flags (gating), assets-unified (consumidores).
