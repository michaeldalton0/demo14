function clientIp(request) {
  const forwarded = request.headers.get("X-Forwarded-For") || "";
  return (
    request.headers.get("CF-Connecting-IP") ||
    forwarded.split(",")[0].trim() ||
    "unknown"
  );
}

async function sha256(value) {
  const bytes = new TextEncoder().encode(value);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function checkRateLimit({ binding, bindingName, key, limitedMessage, unavailableMessage }) {
  if (!binding || typeof binding.limit !== "function") {
    console.error(JSON.stringify({
      message: "Required rate-limit binding is missing",
      binding: bindingName
    }));
    return {
      ok: false,
      status: 503,
      error: unavailableMessage || "Submission protection is temporarily unavailable. Please try again later."
    };
  }

  try {
    const outcome = await binding.limit({ key });
    if (!outcome || typeof outcome.success !== "boolean") {
      throw new Error("Rate-limit binding returned an invalid result.");
    }
    if (!outcome.success) {
      return { ok: false, status: 429, error: limitedMessage };
    }
    return { ok: true };
  } catch (error) {
    console.error(JSON.stringify({
      message: "Rate-limit binding failed",
      binding: bindingName,
      error: String(error && error.message ? error.message : error)
    }));
    return {
      ok: false,
      status: 503,
      error: unavailableMessage || "Submission protection is temporarily unavailable. Please try again later."
    };
  }
}

export async function enforceIpRateLimit({ env, request, scope = "forms", limitedMessage, unavailableMessage }) {
  return checkRateLimit({
    binding: env.IP_RATE_LIMITER,
    bindingName: "IP_RATE_LIMITER",
    key: `${scope}:ip:${clientIp(request)}`,
    limitedMessage: limitedMessage || "Too many requests. Please try again in a minute.",
    unavailableMessage
  });
}

export async function enforceEmailRateLimit({ env, email, scope = "forms", limitedMessage, unavailableMessage }) {
  const normalizedEmail = String(email || "").trim().toLowerCase();
  const emailKey = await sha256(normalizedEmail);
  return checkRateLimit({
    binding: env.EMAIL_RATE_LIMITER,
    bindingName: "EMAIL_RATE_LIMITER",
    key: `${scope}:email:${emailKey}`,
    limitedMessage: limitedMessage || "Too many requests for this email address. Please try again in a minute.",
    unavailableMessage
  });
}
