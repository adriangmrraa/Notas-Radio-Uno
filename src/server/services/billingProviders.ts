/**
 * billingProviders.ts — Clientes de Stripe y MercadoPago (lazy init)
 *
 * NUNCA lanzan por falta de credenciales: devuelven null y el caller decide
 * la respuesta (503 de configuración). Así el módulo compila y el server
 * levanta aunque no haya keys en el entorno.
 */

import Stripe from 'stripe';
import { MercadoPagoConfig } from 'mercadopago';

export function getStripe(): Stripe | null {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) return null;
  return new Stripe(key);
}

export function getMercadoPago(): MercadoPagoConfig | null {
  const token = process.env.MP_ACCESS_TOKEN;
  if (!token) return null;
  return new MercadoPagoConfig({ accessToken: token });
}
