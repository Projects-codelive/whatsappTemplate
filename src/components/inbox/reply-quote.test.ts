import { describe, expect, it } from "vitest";
import { buildReplyPreview } from "./reply-quote";
import { renderTemplateBody } from "@/lib/whatsapp/template-variables";
import type { Message } from "@/types";

// A minimal outbound template message shaped exactly like the row the
// send route persists (content_type='template', rendered body in
// content_text).
function templateMessage(body: string): Message {
  return {
    id: "tpl-1",
    conversation_id: "conv-1",
    sender_type: "agent",
    content_type: "template",
    content_text: body,
    template_name: "independence_offer",
    message_id: "wamid.template.abc",
    status: "sent",
    created_at: new Date(1714500000 * 1000).toISOString(),
  };
}

describe("buildReplyPreview — quote of the original template", () => {
  it("shows the original template body with template variables substituted", () => {
    // The composer renders the body before sending (renderTemplateBody),
    // and the stored content_text is what the reply quote displays.
    const rendered = renderTemplateBody(
      "Hi {{customer_name}}, we've received a request for your 🇮🇳 THIS INDEPENDENCE DAY. Special Offer: {{offer_price}}/month.",
      ["Chetan", "₹10,000"],
    );
    const preview = buildReplyPreview(templateMessage(rendered));
    expect(preview).toBe(
      "Hi Chetan, we've received a request for your 🇮🇳 THIS INDEPENDENCE DAY. Special Offer: ₹10,000/month.",
    );
  });

  it("keeps the button reply's own title as its preview (button-reply rendering intact)", () => {
    const reply: Message = {
      ...templateMessage(""),
      id: "reply-1",
      sender_type: "customer",
      content_type: "interactive",
      content_text: "Yes",
      template_name: undefined,
      message_id: "wamid.button.yes",
    };
    expect(buildReplyPreview(reply)).toBe("Yes");
  });

  it("does not crash when the quoted template body is empty or missing", () => {
    // Template sent by an automation can arrive with a null body.
    expect(buildReplyPreview(templateMessage(""))).toBe("[Template]");
    // A stray interactive row with no text still yields a safe label.
    const stray: Message = {
      ...templateMessage(""),
      id: "stray-1",
      sender_type: "customer",
      content_type: "interactive",
      template_name: undefined,
    };
    expect(buildReplyPreview(stray)).toBe("[Message]");
  });
});
