/* 16-preferences.js
 * Persisting the user's filter preferences, debounced. */

async function savePreferences(preferences) {
  const response = await fetch(
    "/api/preferences",
    {
      method: "POST",
      headers: {
        "Content-Type":
          "application/json",
      },
      body: JSON.stringify(preferences),
    }
  );

  if (
    !response.ok &&
    response.status !== 401
  ) {
    const data = await response.json();

    throw new Error(
      data.error ||
      "Could not save preferences"
    );
  }
}

function queueFilterPreferences() {
  clearTimeout(preferenceSaveTimer);

  preferenceSaveTimer = setTimeout(
    () => {
      savePreferences({
        searchQuery:
          elements.searchInput.value,
        rowTypeFilter:
          elements.rowTypeFilter.value,
      }).catch((error) =>
        showMessage(
          error.message,
          "error"
        )
      );
    },
    300
  );
}

