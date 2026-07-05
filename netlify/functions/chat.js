const { streamNovaResponse } = require("./langchainClient");

exports.handler = async function (event, context) {
  if (event.httpMethod !== "POST") {
    return {
      statusCode: 405,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ error: "Method Not Allowed" }),
    };
  }

  try {
    const payload = JSON.parse(event.body || "{}") || {};
    const messages = payload.messages;

    if (!Array.isArray(messages) || messages.length === 0) {
      return {
        statusCode: 400,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ error: "`messages` must be a non-empty array." }),
      };
    }

    const chunks = [];
    for await (const chunk of streamNovaResponse(messages)) {
      chunks.push(chunk);
    }

    return {
      statusCode: 200,
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
        "Cache-Control": "no-cache",
      },
      body: chunks.join(""),
    };
  } catch (error) {
    console.error("Netlify chat error:", error);
    return {
      statusCode: 500,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        error: error && error.message ? error.message : "Nova failed to respond.",
      }),
    };
  }
};
