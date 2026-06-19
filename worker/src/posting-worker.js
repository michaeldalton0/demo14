import { handlePostingSubmission } from "./posting-review.js";
import { handlePublish, handleNotifySubmitter } from "./publish.js";

const DEFAULT_ALLOWED_ORIGINS = ["https://wp-cna.github.io"];

function allowedOrigins(env) {
  const configured = String(env.ALLOWED_ORIGINS || "")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);

  return configured.length ? configured : DEFAULT_ALLOWED_ORIGINS;
}

function buildCorsHeaders(origin, env) {
  if (!origin) {
    return {};
  }

  if (!allowedOrigins(env).includes(origin)) {
    return null;
  }

  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    Vary: "Origin"
  };
}

function jsonResponse(payload, status = 200, headers = {}) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      ...headers
    }
  });
}

function errorResponse(error, status = 400, headers = {}) {
  return jsonResponse({ ok: false, error }, status, headers);
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin") || "";
    const corsHeaders = buildCorsHeaders(origin, env);
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      if (origin && !corsHeaders) {
        return errorResponse("Origin not allowed.", 403);
      }

      return new Response(null, { status: 204, headers: corsHeaders || {} });
    }

    if (origin && !corsHeaders) {
      return errorResponse("Origin not allowed.", 403);
    }

    if (request.method === "GET" && url.pathname === "/") {
      return jsonResponse(
        { ok: true, service: "WPCNA community posting review" },
        200,
        corsHeaders || {}
      );
    }

    if (request.method === "GET" && url.pathname === "/publish") {
      return handlePublish({ request, env });
    }

    if (request.method === "GET" && url.pathname === "/notify-submitter") {
      return handleNotifySubmitter({ request, env });
    }

    if (url.pathname === "/posting-review" || url.pathname === "/api/posting-review") {
      return handlePostingSubmission({
        request,
        env,
        corsHeaders: corsHeaders || {},
        jsonResponse,
        errorResponse
      });
    }

    return errorResponse("Not found.", 404, corsHeaders || {});
  }
};
