const path = require('path');
const CopyPlugin = require('copy-webpack-plugin');

module.exports = {
   mode: "production",
   entry: {
      "background": ["./src/app/background.ts"],
      "html-page-content": ["./src/app/html-page-content.ts"],
      "preview": ["./src/app/preview.ts"],
      "sandbox": ["./src/app/sandbox.ts"]
   },
   output: {
      path: path.join(__dirname, "dist"),
      filename: "[name].js"
   },
   resolve: {
      extensions: [".ts", ".js"]
   },
   module: {
      rules: [
         {
            test: /\.ts$/,
            loader: "ts-loader",
            exclude: /node_modules/
         }
      ]
   },
   plugins: [
      new CopyPlugin({
         patterns: [{from: ".", to: ".", context: "public"}]
      })
   ]
};