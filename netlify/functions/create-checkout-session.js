// netlify/functions/create-checkout-session.js
// Creates a Stripe Checkout session for the Argus Pro subscription.
// POST { userId, email } → { url }

const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json',
};

exports.handler = async function(event) {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST')    return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'Method not allowed' }) };

  let userId, email;
  try {
    ({ userId, email } = JSON.parse(event.body));
  } catch {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Invalid request body' }) };
  }

  if (!userId || !email) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'userId and email required' }) };
  }

  try {
    // Re-use existing customer if present, otherwise create.
    // Store supabase_user_id in metadata so webhooks can always map back.
    let customerId;
    const existing = await stripe.customers.list({ email, limit: 1 });
    if (existing.data.length) {
      customerId = existing.data[0].id;
      await stripe.customers.update(customerId, { metadata: { supabase_user_id: userId } });
    } else {
      const customer = await stripe.customers.create({ email, metadata: { supabase_user_id: userId } });
      customerId = customer.id;
    }

    // Derive origin for redirect URLs — works on any domain without hardcoding
    const origin = (event.headers && (event.headers.origin || event.headers.referer || '').replace(/\/$/, ''))
      || process.env.SITE_URL
      || 'https://argus-intel.netlify.app';

    const session = await stripe.checkout.sessions.create({
      customer:            customerId,
      mode:                'subscription',
      line_items:          [{ price: process.env.STRIPE_PRICE_ID, quantity: 1 }],
      client_reference_id: userId,           // lets webhook skip an extra API call on first event
      success_url:         origin + '/?upgraded=1',
      cancel_url:          origin + '/',
    });

    return { statusCode: 200, headers: CORS, body: JSON.stringify({ url: session.url }) };

  } catch (err) {
    console.error('create-checkout-session error:', err.message);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: err.message }) };
  }
};
