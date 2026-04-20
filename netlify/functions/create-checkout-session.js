// netlify/functions/create-checkout-session.js
// Builds a Stripe Payment Link URL with client_reference_id and prefilled_email,
// so stripe-webhook.js can map checkout.session.completed back to the Supabase user.
// No Stripe API call required — just returns the constructed URL.

const PAYMENT_LINK = 'https://buy.stripe.com/4gM28t0nY08k1vk3aW5sA00';

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

  const url = new URL(PAYMENT_LINK);
  url.searchParams.set('client_reference_id', userId);
  url.searchParams.set('prefilled_email',     email);

  return { statusCode: 200, headers: CORS, body: JSON.stringify({ url: url.toString() }) };
};
