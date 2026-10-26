export function isStackedLayout(element: Element | null) {
  const dashboard = element?.closest(".guided-dashboard");
  return dashboard ? getComputedStyle(dashboard).display === "flex" : false;
}
