/* Diagnostic UI only: no Photoshop API calls. */
(function () {
  var picker = document.getElementById("picker");
  var menu = document.getElementById("dropdown");
  var label = document.getElementById("pickerName");
  var heading = document.getElementById("heading");
  var message = document.getElementById("message");
  var options = menu.querySelectorAll(".item");
  picker.addEventListener("click", function () {
    menu.style.display = menu.style.display === "none" ? "block" : "none";
  });
  for (var i = 0; i < options.length; i++) {
    options[i].addEventListener("click", function () {
      var name = this.getAttribute("data-name");
      label.textContent = name;
      heading.textContent = name;
      message.textContent = "切换成功：" + name + "。已在同一个面板内切换内容。";
      for (var j = 0; j < options.length; j++) {
        options[j].className = options[j] === this ? "item selected" : "item";
        options[j].querySelector(".check").textContent = options[j] === this ? "✓" : "";
      }
      menu.style.display = "none";
    });
  }
  console.log("[PS Tools Menu Test] External JavaScript loaded successfully");
}());
