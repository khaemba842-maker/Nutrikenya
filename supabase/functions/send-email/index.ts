import "jsr:@supabase/functions-js/edge-runtime.d.ts";

// Supabase Auth "Send Email" hook -> Resend.
// Verified via Standard Webhooks HMAC signature (SEND_EMAIL_HOOK_SECRET),
// not a user JWT -- this function is deployed with verify_jwt=false.

const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY");
const HOOK_SECRET = Deno.env.get("SEND_EMAIL_HOOK_SECRET");
const FROM_EMAIL = Deno.env.get("EMAIL_FROM") || "NutriKenya <onboarding@resend.dev>";

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

function bytesToBase64(buf: ArrayBuffer): string {
  let bin = "";
  const arr = new Uint8Array(buf);
  for (let i = 0; i < arr.length; i++) bin += String.fromCharCode(arr[i]);
  return btoa(bin);
}

async function hmacSha256Base64(secretBytes: Uint8Array, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    secretBytes,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  return bytesToBase64(sig);
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return result === 0;
}

async function verifySignature(payload: string, headers: Headers): Promise<boolean> {
  if (!HOOK_SECRET) return false;
  const id = headers.get("webhook-id");
  const timestamp = headers.get("webhook-timestamp");
  const signatureHeader = headers.get("webhook-signature");
  if (!id || !timestamp || !signatureHeader) return false;

  const rawSecret = HOOK_SECRET.startsWith("v1,") ? HOOK_SECRET.slice(3) : HOOK_SECRET;
  const secretB64 = rawSecret.startsWith("whsec_") ? rawSecret.slice(6) : rawSecret;
  const secretBytes = base64ToBytes(secretB64);

  const signedContent = `${id}.${timestamp}.${payload}`;
  const expected = await hmacSha256Base64(secretBytes, signedContent);

  const signatures = signatureHeader.split(" ").map((s) => s.split(",")[1]).filter(Boolean);
  return signatures.some((sig) => timingSafeEqual(sig, expected));
}

function subjectFor(actionType: string): string {
  switch (actionType) {
    case "recovery": return "Reset your NutriKenya password";
    case "email_change": return "Confirm your new email address";
    case "magiclink": return "Your NutriKenya sign-in link";
    default: return "Confirm your NutriKenya account";
  }
}

function bodyFor(actionType: string, confirmUrl: string): string {
  const action = actionType === "recovery" ? "reset your password"
    : actionType === "email_change" ? "confirm your new email address"
    : actionType === "magiclink" ? "sign in"
    : "confirm your account";
  return `
    <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#070707;color:#fff;padding:32px;">
      <h1 style="font-size:20px;font-weight:800;margin-bottom:16px;">NutriKenya</h1>
      <p style="color:#ccc;font-size:14px;line-height:1.6;">Click the button below to ${action}.</p>
      <a href="${confirmUrl}" style="display:inline-block;margin-top:20px;padding:12px 24px;background:#fff;color:#070707;border-radius:8px;text-decoration:none;font-weight:600;">Continue</a>
      <p style="color:#666;font-size:12px;margin-top:24px;">If you didn't request this, you can safely ignore this email.</p>
    </div>
  `;
}

Deno.serve(async (req: Request) => {
  const payload = await req.text();

  if (!(await verifySignature(payload, req.headers))) {
    return new Response(JSON.stringify({ error: "Invalid signature" }), { status: 401 });
  }

  if (!RESEND_API_KEY) {
    return new Response(JSON.stringify({ error: "Email service not configured" }), { status: 500 });
  }

  let body: any;
  try {
    body = JSON.parse(payload);
  } catch {
    return new Response(JSON.stringify({ error: "Invalid payload" }), { status: 400 });
  }

  const user = body.user || {};
  const emailData = body.email_data || {};
  const actionType = emailData.email_action_type || "signup";
  const siteUrl = emailData.site_url || "";
  const tokenHash = emailData.token_hash || "";
  const redirectTo = emailData.redirect_to || siteUrl;

  const confirmUrl = `${siteUrl}/auth/v1/verify?token=${tokenHash}&type=${actionType}&redirect_to=${encodeURIComponent(redirectTo)}`;

  const resendRes = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: FROM_EMAIL,
      to: [user.email],
      subject: subjectFor(actionType),
      html: bodyFor(actionType, confirmUrl),
    }),
  });

  if (!resendRes.ok) {
    const err = await resendRes.text();
    return new Response(JSON.stringify({ error: "Failed to send email", detail: err }), { status: 500 });
  }

  return new Response(JSON.stringify({}), { status: 200, headers: { "Content-Type": "application/json" } });
});
