import { mountApp } from "../src/lib/mountApp.js";
import LabView from "../src/views/LabView.vue";
import def from "../src/labs/lab03.js";

mountApp(LabView, { def });
