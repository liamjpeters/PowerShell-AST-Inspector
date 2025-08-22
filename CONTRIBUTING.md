# Contributing to PowerShell AST Inspector

Thank you for your interest in contributing! Your help is welcome and appreciated. Please follow these guidelines to ensure a smooth contribution process.

## 📝 How to Contribute

1. **Fork the Repository**
   - Click "Fork" at the top right of the repository page.

2. **Clone Your Fork**
   - `git clone https://github.com/your-username/PowerShell-AST-Inspector.git`

3. **Create a Branch**
   - Use a descriptive branch name:  
     `git checkout -b feature/your-feature-name`

4. **Make Your Changes**
   - Follow the existing code style and structure.
   - Write clear, concise commit messages.

5. **Test Your Changes**
   - Run and test the extension locally in VS Code.
   - Ensure no errors or lint warnings are introduced.

6. **Keep Documentation Updated**
   - Update `README.md` or `SETUP.md` if your change affects usage or setup.
   - Add comments to your code where helpful.

7. **Submit a Pull Request**
   - Push your branch:  
     `git push origin feature/your-feature-name`
   - Open a pull request on GitHub and describe your changes.

## 🔨 Setup Steps

After installing Node.js, run these commands in the project directory:

```bash
# Install dependencies
npm install

# Compile TypeScript to JavaScript
npm run compile
```

## 🏃 Running the Extension

1. Open this project in VS Code
2. Press `F5` or go to 'Run' → "Start Debugging"
3. A new VS Code window will open with your extension loaded
4. Open any PowerShell script
5. Right-click and select "Analyze PowerShell AST" or open the "PowerShell AST"
   view from the sidebar
6. View the AST in the "PowerShellAST" Tree View. Selecting the label of any
   node will display its properties in the "Node Properties" view.

## 💡 Best Practices

- **Follow the Project Structure:**  
  Keep source code in `src/`, assets in `assets/`
- **Write Clear Code:**  
  Use descriptive variable and function names. Add comments for complex logic.
- **Keep Commits Atomic:**  
  Each commit should represent a single logical change.
- **Respect .vscodeignore:**  
  If it doesn't need to be included in the final package, add it to `.vscodeignore`.
- **Test Thoroughly:**  
  Test your changes in both wide and narrow VS Code layouts.

## 🛡️ Code of Conduct

Please be respectful and considerate in all interactions.

## 📬 Questions?

Open an issue or start a discussion if you have questions or need help!
