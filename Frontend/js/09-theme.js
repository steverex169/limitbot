/* 09-theme.js
 * Light/dark theme preference and toggle, plus the page and dialog
 * message banners. */

function getPreferredTheme() {
  const storedTheme = localStorage.getItem(themeStorageKey);

  if (storedTheme === "light" || storedTheme === "dark") {
    return storedTheme;
  }

  return window.matchMedia("(prefers-color-scheme: dark)").matches
    ? "dark"
    : "light";
}

function applyTheme(theme) {
  const nextTheme = theme === "dark" ? "dark" : "light";

  document.documentElement.dataset.theme = nextTheme;
  document.documentElement.style.colorScheme = nextTheme;

  if (elements.themeToggle) {
    elements.themeToggle.setAttribute(
      "aria-pressed",
      String(nextTheme === "dark")
    );

    elements.themeToggle.dataset.theme = nextTheme;

    elements.themeToggle.title =
      nextTheme === "dark"
        ? "Switch to light theme"
        : "Switch to dark theme";
  }
}

function toggleTheme() {
  const currentTheme =
    document.documentElement.dataset.theme === "dark"
      ? "dark"
      : "light";

  const nextTheme =
    currentTheme === "dark"
      ? "light"
      : "dark";

  localStorage.setItem(themeStorageKey, nextTheme);
  applyTheme(nextTheme);
}


function showMessage(text, type = "") {
  elements.message.textContent = text;
  elements.message.className = `message ${type}`.trim();
  elements.message.hidden = false;
}

/*
 * Errors raised while the confirm dialog is open must render inside the
 * dialog: the page behind the modal backdrop is dimmed and inert.
 */
function showDialogMessage(text) {
  if (!elements.dialogMessage) {
    showMessage(text, "error");
    return;
  }
  elements.dialogMessage.textContent = text;
  elements.dialogMessage.hidden = false;
}

function clearDialogMessage() {
  if (elements.dialogMessage) {
    elements.dialogMessage.hidden = true;
  }
}

function clearMessage() {
  elements.message.hidden = true;
}

