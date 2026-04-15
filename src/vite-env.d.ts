declare module "language-tags" {
  const languageTags: {
    check(tag: string): boolean;
  };

  export default languageTags;
}
