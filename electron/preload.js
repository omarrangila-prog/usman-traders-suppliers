// The only bridge between the window and the program's data.
//
// The window has no access to the filesystem, to Node, or to the database. It
// can ask for one of the operations by name and receive the answer, and that
// is all - which is why contextIsolation stays on.

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("usmanTraders", {
  desktop: true,

  /** Run one operation. Mirrors what the web version did over HTTP. */
  call: (method, path, body, query) =>
    ipcRenderer.invoke("ut:call", { method, path, body, query }),

  /** Where the data file is kept, for the settings screen. */
  where: () => ipcRenderer.invoke("ut:where"),

  /** Open the data folder in Explorer. */
  reveal: (target) => ipcRenderer.invoke("ut:reveal", target),

  /** Share this computer's books with the cloud. Never throws. */
  sync: () => ipcRenderer.invoke("ut:sync"),

  /** The cloud address and when it was last shared. */
  sharing: () => ipcRenderer.invoke("ut:sharing"),
  saveSharing: (settings) => ipcRenderer.invoke("ut:sharing/save", settings),

  /** Records where the two sides disagreed, with both versions kept. */
  conflicts: () => ipcRenderer.invoke("ut:conflicts"),

  /** Menu items that the interface has to act on. */
  onMenu: (handler) => ipcRenderer.on("ut:menu", (_event, action) => handler(action)),
});
