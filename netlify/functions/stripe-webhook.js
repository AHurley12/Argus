// netlify/functions/stripe-webhook.js
// Receives Stripe webhook events and updates the Supabase profiles.tier field.
// Webhook signature is verified on every request — never trust unverified payloads.
//
// Required env vars:
//   STRIPE_SECRET_KEY      — sk_live_... or sk_test_...
//   STRIPE_WEBHOOK_SECRET  — whsec_... (from Stripe Dashboard → Webhooks)
//   SUPABASE_URL           — https://xxx.supabase.co
//   SUPABASE_SERVICE_KEY   — service_role key (bypasses RLS for server-side writes)

const stripe   = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { createClient } = require('@supabase/supabase-js');

// ── Supabase write helper ─────────────────────────────────────────────────────
async function setTier(userId, tier) {
  const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
  // Upsert so the row is created if it doesn't exist yet (e.g. signup → pay before first login)
  const { error } = await sb.from('profiles').upsert({ id: userId, tier }, { onConflict: 'id' });
  if (error) throw new Error('Supabase upsert failed: ' + error.message);
  console.log(`stripe-webhook: set profiles.tier="${tier}" for user ${userId}`);
}

// ── Map Stripe customer → Supabase user ID via customer metadata ──────────────
async function userIdFromCustomer(customerId) {
  const customer = await stripe.customers.retrieve(customerId);
  return customer && customer.metadata && customer.metadata.supabase_user_id || null;
}

// ── Handler ───────────────────────────────────────────────────────────────────
exports.handler = async function(event) {
  // Verify signature — event.body is the raw string Netlify passes through
  const sig = event.headers['stripe-signature'];
  let evt;
  try {
    evt = stripe.webhooks.constructEvent(event.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.warn('stripe-webhook: signature verification failed:', err.message);
    return { statusCode: 400, body: `Webhook signature error: ${err.message}` };
  }

  try {
    switch (evt.type) {

      // ── First successful checkout — grant access immediately ───────────────
      case 'checkout.session.completed': {
        const session = evt.data.object;
        const userId  = session.client_reference_id;
        if (userId) {
          await setTier(userId, 'pro');
          // Tag the Stripe customer with the Supabase user ID so that all future
          // webhook events (renewal, payment failure, cancellation) can resolve
          // the correct user without relying on client_reference_id.
          if (session.customer) {
            try {
              await stripe.customers.update(session.customer, {
                metadata: { supabase_user_id: userId },
              });
              console.log('stripe-webhook: tagged customer', session.customer, 'with supabase_user_id', userId);
            } catch (tagErr) {
              // Non-fatal — tier is already set; next renewal will still fail to
              // resolve, but access was granted for this period.
              console.warn('stripe-webhook: failed to tag customer metadata:', tagErr.message);
            }
          }
        }
        break;
      }

      // ── Recurring payment succeeded — keep/restore access ─────────────────
      case 'invoice.payment_succeeded': {
        const invoice = evt.data.object;
        // Skip invoices not tied to a subscription (e.g. one-off charges)
        if (!invoice.subscription) break;
        const userId = invoice.subscription_details?.metadata?.supabase_user_id
          || await userIdFromCustomer(invoice.customer);
        if (userId) await setTier(userId, 'pro');
        break;
      }

      // ── Payment failed — revoke access ────────────────────────────────────
      case 'invoice.payment_failed': {
        const invoice = evt.data.object;
        if (!invoice.subscription) break;
        const userId = await userIdFromCustomer(invoice.customer);
        if (userId) await setTier(userId, 'viewer');
        break;
      }

      // ── Subscription cancelled / expired — revoke access ─────────────────
      case 'customer.subscription.deleted': {
        const sub    = evt.data.object;
        const userId = sub.metadata?.supabase_user_id
          || await userIdFromCustomer(sub.customer);
        if (userId) await setTier(userId, 'viewer');
        break;
      }

      default:
        // All other events ignored — log for visibility
        console.log('stripe-webhook: unhandled event type:', evt.type);
    }
  } catch (err) {
    console.error('stripe-webhook: handler error:', err.message);
    // Return 500 so Stripe retries the webhook
    return { statusCode: 500, body: 'Internal error — will retry' };
  }

  return { statusCode: 200, body: JSON.stringify({ received: true }) };
};
