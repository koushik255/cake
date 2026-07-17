{
  description = "Cake media library server";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs = { self, nixpkgs, flake-utils }:
    flake-utils.lib.eachDefaultSystem (system:
      let
        pkgs = import nixpkgs { inherit system; };
        cake = pkgs.writeShellApplication {
          name = "cake";
          runtimeInputs = [
            pkgs.deno
            pkgs.ffmpeg
          ];
          text = ''
            exec deno task dev "$@"
          '';
        };
      in
      {
        packages.default = cake;
        packages.cake = cake;

        apps.default = {
          type = "app";
          program = "${cake}/bin/cake";
        };
        apps.cake = self.outputs.apps.${system}.default;

        devShells.default = pkgs.mkShell {
          packages = [
            pkgs.deno
            pkgs.ffmpeg
          ];

          shellHook = ''
            echo "Cake dev shell"
            echo "  deno task dev"
            echo "  deno task check"
          '';
        };
      });
}
