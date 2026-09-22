// Check Resend email delivery status
import { Resend } from "resend";

const resend = new Resend("re_QVrSwYSw_6EMnnERLZAzS4v7GdT9yy3cZ");

// Send a test email and log the full response including any errors
const result = await resend.emails.send({
  from: "onboarding@resend.dev",
  to: "dammitafnan@gmail.com",
  subject: "Wait-n-Save: Email Delivery Test",
  text: "If you receive this, email delivery is working.",
});

console.log("Full Resend response:", JSON.stringify(result, null, 2));

// Also list recent emails
const emails = await resend.emails.get(result.data?.id ?? "");
console.log("Email status:", JSON.stringify(emails, null, 2));
