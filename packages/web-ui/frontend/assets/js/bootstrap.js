  // 初始化：按 URL 深链直达对应会话，否则加载历史列表
  const initSid = sidFromUrl();
  if (initSid) {
    openSession(initSid);
  } else {
    loadSessions();
  }

  // 管理台（/app）嵌入时接收预填消息：自动填起始 URL 与任务描述
  window.addEventListener("message", (ev) => {
    if (!ev.data || ev.data.type !== "autotest.prefill") return;
    try {
      const urlInput = document.getElementById("start-url");
      if (urlInput && ev.data.url) urlInput.value = ev.data.url;
      const reqInput = document.getElementById("user-req");
      if (reqInput && ev.data.desc) {
        reqInput.value = ev.data.desc;
        reqInput.focus();
      }
    } catch (e) {
      /* 嵌入页结构变化时忽略 */
    }
  });

  // 同源 sessionStorage 预填（管理台跳转后 iframe 加载时读取一次）
  try {
    if (window.self !== window.top) {
      const raw = sessionStorage.getItem("autotest.prefill");
      if (raw) {
        const pf = JSON.parse(raw);
        const urlInput = document.getElementById("start-url");
        if (urlInput && pf.url) urlInput.value = pf.url;
        const reqInput = document.getElementById("user-req");
        if (reqInput && pf.desc) reqInput.value = pf.desc;
        sessionStorage.removeItem("autotest.prefill");
      }
    }
  } catch (e) {
    /* 访问受限时忽略 */
  }
