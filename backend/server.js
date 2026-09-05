require('dotenv').config();
const express = require('express');
const cors = require('cors');
const Stripe = require('stripe');
const { createClient } = require('@supabase/supabase-js');

const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:5500';
// Origin headers sent by browsers never include a path (just protocol+domain),
// so CORS must check against that alone — even if FRONTEND_URL itself points
// to a subfolder (needed below for success_url/cancel_url).
const FRONTEND_ORIGIN = new URL(FRONTEND_URL).origin;

// Server-side product catalog. NEVER trust a price sent from the browser —
// the cart only sends {name, qty}; the price is always looked up here.
// Keep this in sync with the product cards on the site.
const PRODUCTS = {
  'All-Purpose Bloom Spray': { price: 14.99 },
  'Botanical Concentrate': { price: 18.99 },
};

const app = express();
app.use(cors({ origin: FRONTEND_ORIGIN }));

/**
 * Stripe webhook.
 * IMPORTANT: this route must receive the raw request body (not JSON-parsed)
 * so Stripe's signature check works. That's why it's registered here, BEFORE
 * the global express.json() call below. Don't move express.json() above this.
 */
app.post('/api/stripe-webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;

  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('⚠️  Webhook signature verification failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;

    try {
      const lineItems = await stripe.checkout.sessions.listLineItems(session.id);

      const { error } = await supabase.from('orders').insert({
        stripe_session_id: session.id,
        customer_name: session.metadata?.customer_name || null,
        customer_email: session.customer_details?.email || session.customer_email || null,
        shipping_address: session.metadata?.shipping_address
          ? JSON.parse(session.metadata.shipping_address)
          : null,
        items: lineItems.data.map((li) => ({
          description: li.description,
          quantity: li.quantity,
          amount_total: li.amount_total,
        })),
        amount_total: session.amount_total,
        currency: session.currency,
        status: 'paid',
      });

      if (error) console.error('Supabase insert error:', error);
    } catch (err) {
      console.error('Error processing checkout.session.completed:', err);
    }

    // Confirmation emails are sent from the browser via EmailJS on the
    // success page (see success.html) — EmailJS is a client-side SDK, it
    // doesn't run from inside a Node server. If you'd rather send email
    // from here instead, swap in a transactional provider (Resend,
    // SendGrid, SES) and call it in this block — that also works if the
    // customer closes the tab before success.html loads.
  }

  res.json({ received: true });
});

// Every other route gets normal JSON body parsing.
app.use(express.json());

app.get('/', (req, res) => {
  res.send('BloomiEssence backend is running.');
});

// Called by the "Complete Order" button in bloomiessence.html.
app.post('/api/create-checkout-session', async (req, res) => {
  try {
    const { items, customer } = req.body;

    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: 'Cart is empty.' });
    }
    if (!customer?.email || !customer?.name) {
      return res.status(400).json({ error: 'Missing customer details.' });
    }

    const line_items = items.map((item) => {
      const product = PRODUCTS[item.name];
      if (!product) throw new Error(`Unknown product: ${item.name}`);
      return {
        price_data: {
          currency: 'usd',
          product_data: { name: item.name },
          unit_amount: Math.round(product.price * 100),
        },
        quantity: item.qty,
      };
    });

    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      payment_method_types: ['card'],
      line_items,
      customer_email: customer.email,
      metadata: {
        customer_name: customer.name,
        // Stripe metadata values are capped at 500 chars — fine for a normal address.
        shipping_address: JSON.stringify(customer.address || {}),
      },
      success_url: `${FRONTEND_URL}/success.html?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${FRONTEND_URL}/`,
    });

    res.json({ url: session.url });
  } catch (err) {
    console.error('Error creating checkout session:', err);
    res.status(500).json({ error: err.message || 'Could not create checkout session.' });
  }
});

// Polled by success.html to fetch the order once the webhook has saved it.
app.get('/api/order/:sessionId', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('orders')
      .select('*')
      .eq('stripe_session_id', req.params.sessionId)
      .maybeSingle();

    if (error) throw error;
    if (!data) return res.status(202).json({ pending: true }); // webhook hasn't landed yet

    res.json(data);
  } catch (err) {
    console.error('Error fetching order:', err);
    res.status(500).json({ error: 'Could not fetch order.' });
  }
});

const PORT = process.env.PORT || 4242;
app.listen(PORT, () => console.log(`BloomiEssence backend listening on port ${PORT}`));
