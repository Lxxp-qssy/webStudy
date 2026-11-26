import { createApp } from "vue";
import "../src/styles/index.css";
import LabView from "../src/views/LabView.vue";
import def from "../src/labs/lab05.js";

createApp(LabView, { def }).mount("#app");
