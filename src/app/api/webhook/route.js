import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

export async function GET() {
  return Response.json({
    success: true,
    status: "Webhook is running 🚀",
  });
}

export async function POST(req) {
  try {
    const body = await req.json();

    console.log("🔥 WEBHOOK RECEIVED:");
    console.log(JSON.stringify(body, null, 2));

    const message =
      body?.message ||
      body?.text ||
      body?.entry?.[0]?.changes?.[0]?.value?.messages?.[0]?.text?.body ||
      null;

    const from =
      body?.phone ||
      body?.from ||
      body?.entry?.[0]?.changes?.[0]?.value?.messages?.[0]?.from ||
      null;

    console.log("📩 Message:", message);
    console.log("📱 From:", from);

    // Save into Supabase
    const { error } = await supabase.from("webhooks").insert([
      {
        from_number: from,
        message,
        payload: body,
        created_at: new Date().toISOString(),
      },
    ]);

    if (error) {
      console.error("❌ Supabase Error:", error);
    }

    // Automation triggers
    const msg = message?.toLowerCase()?.trim();

    if (["hi", "hii", "hey", "hello"].includes(msg)) {
      console.log("🤖 Welcome automation triggered");
    }

    if (msg === "price" || msg === "pricing") {
      console.log("💰 Pricing automation triggered");
    }

    if (msg?.includes("demo")) {
      console.log("🎯 Demo automation triggered");
    }

    return Response.json({
      success: true,
      received: body,
    });

  } catch (error) {
    console.error("🔥 WEBHOOK ERROR:", error);

    return Response.json(
      {
        success: false,
        error: error.message,
      },
      { status: 500 }
    );
  }
}