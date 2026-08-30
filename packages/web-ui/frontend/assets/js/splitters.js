  // ============ 三栏可拖拽分割线 ============
  function clamp(v, lo, hi) { return Math.min(Math.max(v, lo), hi); }

  function initSplitters() {
    const app = document.querySelector('.app');
    const leftPane = document.getElementById('sessions-pane');
    const chatPane = document.querySelector('.chat-pane');
    const rightPane = document.querySelector('.exec-pane');
    const CHAT_MIN = 380;      // 中列（对话）最小宽度，保证不被挤没
    const DIV_W = 12;          // 左右两条分隔条共 12px

    document.querySelectorAll('.vdivider').forEach(dv => {
      const dir = dv.dataset.dir;                    // 'left' | 'right'
      const pane = dir === 'left' ? leftPane : rightPane;
      const lo = dir === 'left' ? 220 : 340;         // 对应栏最小宽度

      dv.addEventListener('mousedown', e => {
        e.preventDefault();
        const startX = e.clientX;
        const startW = pane.getBoundingClientRect().width;
        document.body.classList.add('resizing');
        dv.classList.add('active');

        const onMove = ev => {
          const delta = ev.clientX - startX;
          const total = app.clientWidth;
          let w;
          if (dir === 'left') {
            w = startW + delta;                      // 向右拖 → 左栏变宽
            const hi = total - rightPane.offsetWidth - CHAT_MIN - DIV_W;
            leftPane.style.flexBasis = clamp(w, lo, Math.max(lo, hi)) + 'px';
            leftPane.style.width = leftPane.style.flexBasis;
          } else {
            w = startW - delta;                      // 向右拖 → 分隔条右移,右栏变窄
            const hi = total - leftPane.offsetWidth - CHAT_MIN - DIV_W;
            rightPane.style.flexBasis = clamp(w, lo, Math.max(lo, hi)) + 'px';
            rightPane.style.width = rightPane.style.flexBasis;
          }
        };
        const onUp = () => {
          document.removeEventListener('mousemove', onMove);
          document.removeEventListener('mouseup', onUp);
          document.body.classList.remove('resizing');
          dv.classList.remove('active');
        };
        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup', onUp);
      });
    });
  }
  initSplitters();
