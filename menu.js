/* Stable UXP menu. Only Nine Slice is connected in this test branch. */
(function () {
  var picker = document.getElementById("picker");
  var menu = document.getElementById("dropdown");
  var label = document.getElementById("pickerName");
  var heading = document.getElementById("heading");
  var message = document.getElementById("message");
  var options = menu.querySelectorAll(".item");
  var loadedNineSlice = false;
  picker.addEventListener("click", function () {
    menu.style.display = menu.style.display === "none" ? "block" : "none";
  });
  for (var i = 0; i < options.length; i++) {
    options[i].addEventListener("click", function () {
      var name = this.getAttribute("data-name");
      label.textContent = name;
      heading.textContent = name;
      message.textContent = "此工具将在后续测试阶段接入。";
      for (var j = 0; j < options.length; j++) {
        options[j].className = options[j] === this ? "item selected" : "item";
        options[j].querySelector(".check").textContent = options[j] === this ? "✓" : "";
      }
      var activeNine = name === "九宫格拉伸";
      var nineView = document.getElementById("nineSliceView");
      nineView.style.display = activeNine ? "block" : "none";
      heading.style.display = activeNine ? "none" : "block";
      message.style.display = activeNine ? "none" : "block";
      document.querySelector(".spacer").style.display = activeNine ? "none" : "block";
      document.getElementById("bottomText").style.display = activeNine ? "none" : "block";
      var area = document.getElementById("bodyArea");
      if (activeNine) area.classList.add("nine-active");
      else area.classList.remove("nine-active");
      menu.style.display = "none";
      if (activeNine && !loadedNineSlice) {
        try {
          require("./nine-slice.js")(nineView);
          loadedNineSlice = true;
        } catch (error) {
          console.error("[Photoshop Tools] Nine Slice failed:", error);
          nineView.style.display = "none";
          area.classList.remove("nine-active");
          heading.style.display = "block";
          message.style.display = "block";
          heading.textContent = "九宫格工具启动失败";
          message.textContent = String(error && error.message || error);
        }
      }
    });
  }
}());
