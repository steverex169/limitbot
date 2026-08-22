/* 04-telegram-alerts.js
 * Telegram Alerts page: recipient list rendering, membership flags, and
 * the loader for saved recipients. */

function showTelegramAlertsMessage(message, kind = "success") {
  if (!elements.telegramAlertsMessage) {
    return;
  }
  elements.telegramAlertsMessage.textContent = message;
  elements.telegramAlertsMessage.className = `message ${kind}`;
  elements.telegramAlertsMessage.hidden = !message;
}

function recipientMembershipText(recipient) {
  if (recipient.isAcesHigh && recipient.isBetWar) return "All";
  if (recipient.isAcesHigh) return "AcesHigh only";
  if (recipient.isBetWar) return "BetWar only";
  return "All";
}

function recipientAudienceValue(recipient) {
  if (recipient.isAcesHigh && recipient.isBetWar) return "all";
  if (recipient.isAcesHigh) return "aceshigh";
  if (recipient.isBetWar) return "betwar";
  return "all";
}

function applyRecipientAudienceUI(selectElement, recipient) {
  if (!selectElement) {
    return;
  }
  selectElement.value = recipientAudienceValue(recipient);
}

function getRecipientAudienceValue(isEdit = false) {
  const value = String(
    isEdit ? elements.telegramEditAudience?.value : elements.telegramAlertAudience?.value
  ).toLowerCase();
  return ["all", "aceshigh", "betwar"].includes(value) ? value : "all";
}

function audienceToMembershipFlags(audience) {
  const value = String(audience || "all").toLowerCase();
  if (value === "aceshigh") return { isAcesHigh: true, isBetWar: false };
  if (value === "betwar") return { isAcesHigh: false, isBetWar: true };
  return { isAcesHigh: true, isBetWar: true };
}

function renderTelegramChats() {
  if (!elements.telegramAlertRows) {
    return;
  }

  elements.telegramAlertRows.replaceChildren();

  if (!state.telegramChats.length) {
    const row = document.createElement("tr");
    const cell = document.createElement("td");
    cell.colSpan = 4;
    cell.className = "empty-state";
    cell.style.textAlign = "center";
    cell.textContent = "No Telegram recipients added yet.";
    row.append(cell);
    elements.telegramAlertRows.append(row);
    return;
  }

  state.telegramChats.forEach((recipient) => {
    const row = document.createElement("tr");

    const nameCell = document.createElement("td");
    nameCell.textContent = recipient.name;

    const chatCell = document.createElement("td");
    chatCell.textContent = recipient.chatId;

    const membershipCell = document.createElement("td");
    membershipCell.textContent = recipientMembershipText(recipient);

    const actionCell = document.createElement("td");
    const actionWrap = document.createElement("div");
    actionWrap.className = "telegram-action-buttons";

    const editButton = document.createElement("button");
    editButton.type = "button";
    editButton.className = "telegram-edit-button";
    editButton.textContent = "Edit";

    editButton.addEventListener("click", () => {
      state.editingTelegramRecipientId = recipient.id;
      elements.telegramEditName.value = recipient.name;
      elements.telegramEditChatId.value = recipient.chatId;
      applyRecipientAudienceUI(elements.telegramEditAudience, recipient);
      elements.telegramEditMessage.textContent = "";
      elements.telegramEditMessage.hidden = true;
      elements.telegramEditDialog.showModal();
      elements.telegramEditName.focus();
    });

    const deleteButton = document.createElement("button");
    deleteButton.type = "button";
    deleteButton.className = "danger-button telegram-delete-button";
    deleteButton.textContent = "Delete";

    deleteButton.addEventListener("click", async () => {
      if (!window.confirm(`Delete Telegram recipient ${recipient.name}?`)) {
        return;
      }

      deleteButton.disabled = true;
      try {
        const response = await fetch("/api/telegram-chats/delete", {
          method: "POST",
          headers: {"Content-Type": "application/json"},
          body: JSON.stringify({id: recipient.id}),
        });
        const data = await response.json();
        if (!response.ok) {
          throw new Error(data.error || "Could not delete Telegram recipient");
        }

        state.telegramChats = state.telegramChats.filter(
          (item) => item.id !== recipient.id
        );
        renderTelegramChats();
        showTelegramAlertsMessage("Telegram recipient deleted.", "success");
      } catch (error) {
        showTelegramAlertsMessage(error.message, "error");
      } finally {
        deleteButton.disabled = false;
      }
    });

    actionWrap.append(editButton, deleteButton);
    actionCell.append(actionWrap);
    row.append(nameCell, chatCell, membershipCell, actionCell);
    elements.telegramAlertRows.append(row);
  });
}


async function loadTelegramChats() {
  const response = await fetch("/api/telegram-chats", {cache: "no-store"});
  const data = await response.json();

  if (!response.ok) {
    throw new Error(data.error || "Could not load Telegram recipients");
  }

  state.telegramChats = Array.isArray(data.recipients) ? data.recipients : [];
  renderTelegramChats();
  return state.telegramChats;
}


