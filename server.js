const express = require("express");
const multer = require("multer");
const fs = require("fs");
const path = require("path");

const app = express();
const upload = multer({ storage: multer.memoryStorage() });

/*
  TELEGRAM BOT SETUP SECTION
  Put your Telegram bot token and your Telegram user/chat ID here.
  The bot token stays on the backend, not inside the HTML.
*/
const telegramConfig = {
  botToken: "PUT_YOUR_TELEGRAM_BOT_TOKEN_HERE",
  chatId: "PUT_YOUR_TELEGRAM_USER_OR_CHAT_ID_HERE"
};

const PORT = process.env.PORT || 3000;
const dbPath = path.join(__dirname, "support-db.json");

app.use(express.json({ limit: "1mb" }));
app.use(express.static(__dirname));

function readDb() {
  try {
    return JSON.parse(fs.readFileSync(dbPath, "utf8"));
  } catch {
    return {
      accounts: {},
      uploads: {},
      lastTelegramUpdateId: 0
    };
  }
}

function writeDb(db) {
  fs.writeFileSync(dbPath, JSON.stringify(db, null, 2));
}

function ensureAccount(db, email, details = {}) {
  const normalizedEmail = String(email || "").trim().toLowerCase();
  if (!normalizedEmail) return null;

  if (!db.accounts[normalizedEmail]) {
    db.accounts[normalizedEmail] = {
      email: normalizedEmail,
      name: details.name || "",
      supportCount: Number(details.supportCount || 0),
      voteCount: Number(details.voteCount || 0),
      createdAt: new Date().toISOString(),
      approvals: []
    };
  } else {
    db.accounts[normalizedEmail].name = details.name || db.accounts[normalizedEmail].name || "";
    db.accounts[normalizedEmail].supportCount = Math.max(
      Number(db.accounts[normalizedEmail].supportCount || 0),
      Number(details.supportCount || 0)
    );
    db.accounts[normalizedEmail].voteCount = Math.max(
      Number(db.accounts[normalizedEmail].voteCount || 0),
      Number(details.voteCount || 0)
    );
  }

  return db.accounts[normalizedEmail];
}

function isTelegramConfigured() {
  return (
    telegramConfig.botToken &&
    telegramConfig.chatId &&
    !telegramConfig.botToken.includes("PUT_YOUR") &&
    !telegramConfig.chatId.includes("PUT_YOUR")
  );
}

async function telegramRequest(method, body) {
  if (!isTelegramConfigured()) {
    console.warn("Telegram is not configured yet.");
    return null;
  }

  const response = await fetch(`https://api.telegram.org/bot${telegramConfig.botToken}/${method}`, {
    method: "POST",
    body
  });

  const result = await response.json().catch(() => null);

  if (!response.ok) {
    console.error("Telegram API error:", result || response.statusText);
    throw new Error("Telegram API request failed.");
  }

  return result;
}

async function sendUploadToTelegram({ uploadId, email, uploadType, transaction, file }) {
  const caption = [
    "New support upload",
    `User: ${email}`,
    `Type: ${uploadType || "support"}`,
    transaction ? `Transaction: ${transaction}` : "",
    `File: ${file.originalname}`,
    `Submitted: ${new Date().toLocaleString()}`,
    "",
    "Do you accept this?"
  ].filter(Boolean).join("\n");

  const inlineKeyboard = JSON.stringify({
    inline_keyboard: [
      [
        { text: "✅ Yes, accept", callback_data: `accept:${uploadId}` },
        { text: "❌ No, reject", callback_data: `reject:${uploadId}` }
      ]
    ]
  });

  const isImage = String(file.mimetype || "").startsWith("image/");
  const formData = new FormData();
  formData.append("chat_id", telegramConfig.chatId);
  formData.append("caption", caption);
  formData.append("reply_markup", inlineKeyboard);

  const blob = new Blob([file.buffer], { type: file.mimetype || "application/octet-stream" });
  formData.append(isImage ? "photo" : "document", blob, file.originalname || "upload");

  return telegramRequest(isImage ? "sendPhoto" : "sendDocument", formData);
}

app.post("/api/account", (req, res) => {
  const db = readDb();
  const account = ensureAccount(db, req.body.email, req.body);
  if (!account) {
    return res.status(400).json({ ok: false, message: "Email is required." });
  }
  writeDb(db);
  res.json({ ok: true, account });
});

app.get("/api/account/:email", (req, res) => {
  const db = readDb();
  const email = String(req.params.email || "").trim().toLowerCase();
  const account = db.accounts[email];
  if (!account) {
    return res.status(404).json({ ok: false, message: "Account not found." });
  }
  res.json(account);
});

// New endpoint to update all users' support count to 5
app.post("/api/update-all-support-count", (req, res) => {
  const db = readDb();
  const accountsArray = Object.values(db.accounts);
  
  accountsArray.forEach((account) => {
    account.supportCount = 5;
  });
  
  writeDb(db);
  
  res.json({
    ok: true,
    message: `Updated ${accountsArray.length} user(s) support count to 5`,
    updatedCount: accountsArray.length,
    accounts: accountsArray
  });
});

app.post("/api/support-upload", upload.single("file"), async (req, res) => {
  const email = String(req.body.email || "").trim().toLowerCase();
  if (!email) {
    return res.status(400).json({ ok: false, message: "User email is required." });
  }

  if (!req.file) {
    return res.status(400).json({ ok: false, message: "Upload file is required." });
  }

  const db = readDb();
  ensureAccount(db, email);

  const uploadId = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  db.uploads[uploadId] = {
    id: uploadId,
    email,
    uploadType: req.body.uploadType || "support",
    transaction: req.body.transaction || "",
    fileName: req.file.originalname,
    fileType: req.file.mimetype,
    status: "pending",
    submittedAt: new Date().toISOString()
  };
  writeDb(db);

  try {
    await sendUploadToTelegram({
      uploadId,
      email,
      uploadType: req.body.uploadType,
      transaction: req.body.transaction,
      file: req.file
    });
  } catch (error) {
    console.error(error);
    return res.status(502).json({
      ok: false,
      message: "Saved upload, but Telegram sending failed. Check your bot token/chat ID."
    });
  }

  res.json({ ok: true, uploadId, status: "pending" });
});

async function answerCallbackQuery(callbackQueryId, text) {
  const formData = new FormData();
  formData.append("callback_query_id", callbackQueryId);
  formData.append("text", text);
  formData.append("show_alert", "false");
  return telegramRequest("answerCallbackQuery", formData);
}

async function editTelegramMessage(callbackQuery, text) {
  const message = callbackQuery.message;
  if (!message) return;

  const formData = new FormData();
  formData.append("chat_id", message.chat.id);
  formData.append("message_id", message.message_id);
  formData.append("reply_markup", JSON.stringify({ inline_keyboard: [] }));

  const captionText = message.caption ? `${message.caption}\n\n${text}` : text;
  formData.append("caption", captionText);

  try {
    await telegramRequest("editMessageCaption", formData);
  } catch {
    const fallback = new FormData();
    fallback.append("chat_id", message.chat.id);
    fallback.append("message_id", message.message_id);
    fallback.append("text", text);
    fallback.append("reply_markup", JSON.stringify({ inline_keyboard: [] }));
    try {
      await telegramRequest("editMessageText", fallback);
    } catch (error) {
      console.warn("Could not edit Telegram message:", error.message);
    }
  }
}

async function handleTelegramCallback(callbackQuery) {
  const data = String(callbackQuery.data || "");
  const [action, uploadId] = data.split(":");

  if (!["accept", "reject"].includes(action) || !uploadId) {
    await answerCallbackQuery(callbackQuery.id, "Unknown action.");
    return;
  }

  const db = readDb();
  const uploadItem = db.uploads[uploadId];

  if (!uploadItem) {
    await answerCallbackQuery(callbackQuery.id, "Upload not found.");
    return;
  }

  if (uploadItem.status !== "pending") {
    await answerCallbackQuery(callbackQuery.id, `Already ${uploadItem.status}.`);
    return;
  }

  const account = ensureAccount(db, uploadItem.email);

  if (action === "accept") {
    uploadItem.status = "accepted";
    uploadItem.reviewedAt = new Date().toISOString();
    account.supportCount = Number(account.supportCount || 0) + 1;
    account.approvals = account.approvals || [];
    account.approvals.push({
      uploadId,
      type: uploadItem.uploadType,
      at: uploadItem.reviewedAt
    });
    writeDb(db);

    await answerCallbackQuery(callbackQuery.id, "Accepted. User support number increased.");
    await editTelegramMessage(callbackQuery, `✅ Accepted. ${account.email} support number is now ${account.supportCount}.`);
    return;
  }

  uploadItem.status = "rejected";
  uploadItem.reviewedAt = new Date().toISOString();
  writeDb(db);

  await answerCallbackQuery(callbackQuery.id, "Rejected. User number was not changed.");
  await editTelegramMessage(callbackQuery, `❌ Rejected. ${account.email} support number stayed at ${account.supportCount}.`);
}

async function pollTelegramUpdates() {
  if (!isTelegramConfigured()) return;

  const db = readDb();
  const offset = Number(db.lastTelegramUpdateId || 0) + 1;
  const formData = new FormData();
  formData.append("offset", String(offset));
  formData.append("timeout", "20");
  formData.append("allowed_updates", JSON.stringify(["callback_query"]));

  try {
    const result = await telegramRequest("getUpdates", formData);
    if (!result || !Array.isArray(result.result)) return;

    for (const update of result.result) {
      db.lastTelegramUpdateId = Math.max(Number(db.lastTelegramUpdateId || 0), Number(update.update_id || 0));
      writeDb(db);

      if (update.callback_query) {
        await handleTelegramCallback(update.callback_query);
      }
    }
  } catch (error) {
    console.error("Telegram polling error:", error.message);
  }
}

setInterval(pollTelegramUpdates, 3000);

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
  console.log("Open http://localhost:3000/matthew-west-private-page-telegram-approval.html");
});
