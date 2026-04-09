const mongoose = require("mongoose");

const orderItemSchema = new mongoose.Schema(
  {
    productId: { type: mongoose.Schema.Types.ObjectId, ref: "Product", required: true },
    name: { type: String, required: true },
    unitPrice: { type: Number, required: true, min: 1 },
    quantity: { type: Number, required: true, min: 1 },
    subtotal: { type: Number, required: true, min: 1 },
  },
  { _id: false }
);

const orderSchema = new mongoose.Schema(
  {
    customerName: { type: String, required: true, trim: true },
    items: { type: [orderItemSchema], default: [] },
    total: { type: Number, required: true, min: 1 },
    status: {
      type: String,
      enum: ["pending", "completed"],
      default: "pending",
    },
    invoiceNumber: { type: String, required: true, unique: true },
  },
  { timestamps: true }
);

module.exports = mongoose.model("Order", orderSchema);
