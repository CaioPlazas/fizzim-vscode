export interface MenuItem {
  label: string;
  action: () => void;
}

let currentMenu: HTMLDivElement | null = null;

function closeMenu(): void {
  if (currentMenu) {
    currentMenu.remove();
    currentMenu = null;
  }
}

export function showContextMenu(clientX: number, clientY: number, items: MenuItem[]): void {
  closeMenu();
  if (items.length === 0) return;

  const menu = document.createElement('div');
  menu.style.position = 'fixed';
  menu.style.left = `${clientX}px`;
  menu.style.top = `${clientY}px`;
  menu.style.background = 'var(--vscode-menu-background, #2d2d2d)';
  menu.style.color = 'var(--vscode-menu-foreground, #cccccc)';
  menu.style.border = '1px solid var(--vscode-menu-border, #454545)';
  menu.style.padding = '4px 0';
  menu.style.fontFamily = 'var(--vscode-font-family, sans-serif)';
  menu.style.fontSize = '13px';
  menu.style.zIndex = '1000';
  menu.style.minWidth = '160px';
  menu.style.boxShadow = '0 2px 8px rgba(0,0,0,0.3)';

  for (const item of items) {
    const el = document.createElement('div');
    el.textContent = item.label;
    el.style.padding = '4px 12px';
    el.style.cursor = 'pointer';
    el.addEventListener('mouseenter', () => {
      el.style.background = 'var(--vscode-menu-selectionBackground, #094771)';
    });
    el.addEventListener('mouseleave', () => {
      el.style.background = '';
    });
    el.addEventListener('click', (e) => {
      e.stopPropagation();
      closeMenu();
      item.action();
    });
    menu.appendChild(el);
  }

  document.body.appendChild(menu);
  currentMenu = menu;

  const dismiss = () => {
    closeMenu();
    document.removeEventListener('click', dismiss);
    document.removeEventListener('contextmenu', dismiss);
  };
  // defer so the contextmenu event that opened this menu doesn't immediately close it
  setTimeout(() => {
    document.addEventListener('click', dismiss);
    document.addEventListener('contextmenu', dismiss);
  }, 0);
}
