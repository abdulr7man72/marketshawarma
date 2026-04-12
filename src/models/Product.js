const mongoose = require("mongoose");

const productSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    price: { type: Number, required: true, min: 1 },
    quantity: { type: Number, default: 0, min: 0 },
    image: { type: String, default: "", trim: true },
    category: { type: String, default: "General", trim: true },
    isEditable: { type: Boolean, default: false },
  },
  { timestamps: true }
);

module.exports = mongoose.model("Product", productSchema);
