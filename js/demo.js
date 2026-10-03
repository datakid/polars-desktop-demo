['floe.project.v1', 'floe.ui', 'floe.filePath', 'floe.fileName', 'floe.savedHash', 'pqx.project.v1', 'pqx.ui'].forEach((k) => { try { localStorage.removeItem(k); } catch (e) { } });
location.replace('index.html?demo' + (location.search ? '&' + location.search.slice(1) : ''));
