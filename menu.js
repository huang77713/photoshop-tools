// Menu-only test: no require("photoshop"), no UXP scripting, no tool modules.
const toggle = document.getElementById("toggle");
const menu = document.getElementById("menu");
const label = document.getElementById("currentName");
const title = document.getElementById("toolTitle");
const note = document.getElementById("note");
toggle.addEventListener("click", function () {
  menu.style.display = menu.style.display === "none" ? "block" : "none";
});
const items = menu.querySelectorAll(".item");
for (const item of items) {
  item.addEventListener("click", function () {
    const name = item.getAttribute("data-name");
    label.textContent = name;
    title.textContent = name;
    note.textContent = "已成功切换到「" + name + "」测试页面。此版本没有加载实际功能代码。";
    for (const other of items) {
      const selected = other === item;
      other.classList.toggle("active", selected);
      other.querySelector(".check").textContent = selected ? "✓" : "";
    }
    menu.style.display = "none";
  });
}
