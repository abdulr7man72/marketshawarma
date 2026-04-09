(function () {
  let deferredPrompt = null;

  function bindInstallButton(selector) {
    const button = document.querySelector(selector);
    if (!button) return;

    const updateVisibility = () => {
      if (deferredPrompt) {
        button.classList.remove("hidden");
      } else {
        button.classList.add("hidden");
      }
    };

    button.addEventListener("click", async () => {
      if (!deferredPrompt) return;
      deferredPrompt.prompt();
      await deferredPrompt.userChoice;
      deferredPrompt = null;
      updateVisibility();
    });

    window.addEventListener("beforeinstallprompt", (event) => {
      event.preventDefault();
      deferredPrompt = event;
      updateVisibility();
    });

    window.addEventListener("appinstalled", () => {
      deferredPrompt = null;
      updateVisibility();
    });

    updateVisibility();
  }

  if ("serviceWorker" in navigator) {
    window.addEventListener("load", () => {
      navigator.serviceWorker.register("/sw.js").catch(() => {
        /* ignore registration error */
      });
    });
  }

  window.PWAInstall = {
    bindInstallButton,
  };
})();
